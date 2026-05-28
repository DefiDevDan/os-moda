{ config, lib, pkgs, ... }:
let
  spawn-alert = pkgs.writeShellScriptBin "spawn-alert" ''
    MSG="$*"
    [ -z "$MSG" ] && { echo "usage: spawn-alert <message>"; exit 2; }
    TOK_FILE=/var/lib/osmoda/secrets/telegram-bot-token
    CHAT_FILE=/var/lib/osmoda/secrets/telegram-chat-id
    if [ ! -r "$TOK_FILE" ] || [ ! -r "$CHAT_FILE" ]; then
      echo "[spawn-alert] telegram not configured (need $TOK_FILE + $CHAT_FILE) — would have sent: $MSG"
      exit 0
    fi
    TOK=$(cat "$TOK_FILE"); CHAT=$(cat "$CHAT_FILE")
    HOST=$(hostname); STAMP=$(date -Iseconds)
    ${pkgs.curl}/bin/curl -sf --max-time 10 -X POST \
      "https://api.telegram.org/bot$TOK/sendMessage" \
      -d "chat_id=$CHAT" --data-urlencode "text=[$HOST $STAMP] $MSG" >/dev/null \
      && echo "[spawn-alert] sent" \
      || echo "[spawn-alert] telegram API call failed"
  '';

  spawn-backup = pkgs.writeShellScriptBin "spawn-backup" ''
    set -e
    SECRETS=/var/lib/osmoda/secrets
    AGE_FILE=$SECRETS/backup-age-recipient
    DEST_FILE=$SECRETS/backup-rsync-target
    KEY_FILE=$SECRETS/backup-ssh-key
    if [ ! -r "$AGE_FILE" ] || [ ! -r "$DEST_FILE" ] || [ ! -r "$KEY_FILE" ]; then
      echo "[backup] off-box backup not configured (need $AGE_FILE + $DEST_FILE + $KEY_FILE) — skipping"
      exit 0
    fi
    RECIPIENT=$(cat "$AGE_FILE")
    DEST=$(cat "$DEST_FILE")
    KEY=$(cat "$KEY_FILE")
    [ -f "$KEY" ] || { echo "[backup] SSH key file '$KEY' not found"; exit 1; }
    STAMP=$(date -u +%Y%m%d_%H%M%S)
    TMP=$(mktemp -d); trap "rm -rf $TMP" EXIT
    OUT=$TMP/spawn-data-$STAMP.tar.age
    echo "[backup] snapshotting /opt/spawn-app/data → $OUT"
    ${pkgs.gnutar}/bin/tar -C /opt/spawn-app -cf - data 2>/dev/null \
      | ${pkgs.age}/bin/age -r "$RECIPIENT" -o "$OUT"
    SIZE=$(${pkgs.coreutils}/bin/stat -c %s "$OUT")
    REMOTE_HOST=$(echo "$DEST" | cut -d: -f1)
    REMOTE_DIR=$(echo "$DEST" | cut -d: -f2-)
    echo "[backup] uploading $SIZE bytes to $DEST"
    ${pkgs.rsync}/bin/rsync -e "${pkgs.openssh}/bin/ssh -i $KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes" \
      "$OUT" "$DEST/"
    ${pkgs.openssh}/bin/ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$REMOTE_HOST" \
      "find $REMOTE_DIR -type f -name 'spawn-data-*.tar.age' ! -name 'spawn-data-*01_*.tar.age' -mtime +30 -delete 2>/dev/null; \
       find $REMOTE_DIR -type f -name 'spawn-data-*01_*.tar.age' -mtime +365 -delete 2>/dev/null" \
      || echo "[backup] remote prune step failed (non-fatal — Storage Box ssh shell may be limited)"
    echo "[backup] OK ($SIZE bytes)"
    ${spawn-alert}/bin/spawn-alert "✅ off-box backup OK ($SIZE bytes) → $DEST" || true
  '';
in {
  imports = [ ./hardware-configuration.nix ./networking.nix ];

  services.logrotate.checkConfig = false;
  boot.tmp.cleanOnBoot = true;
  zramSwap.enable = true;
  networking.hostName = "agentos-cloud";
  services.openssh.enable = true;
  services.openssh.settings.PermitRootLogin = "prohibit-password";

  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMRfgoK7tKkPUX49Et2CwJDIX7QHocySALiuTV2+3bHf agentos-hetzner"
  ];
  users.users.agent = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMRfgoK7tKkPUX49Et2CwJDIX7QHocySALiuTV2+3bHf agentos-hetzner"
    ];
  };

  security.sudo.wheelNeedsPassword = false;
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  environment.systemPackages = with pkgs; [
    git vim tmux htop curl jq ripgrep fd
    gcc gnumake cmake pkg-config sqlite openssl
    rustc cargo nodejs_22
    certbot
    age rsync openssh
    spawn-alert spawn-backup
  ];

  systemd.services.spawn-app = {
    description = "spawn.os.moda Web App";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" "nginx.service" ];
    wants = [ "network-online.target" ];
    path = [ pkgs.nodejs_22 pkgs.openssh pkgs.python3 pkgs.coreutils ];
    serviceConfig = {
      Type = "simple";
      WorkingDirectory = "/opt/spawn-app";
      ExecStart = "${pkgs.nodejs_22}/bin/node server.js";
      Restart = "always";
      RestartSec = 5;
      EnvironmentFile = [ "/opt/spawn-app/.env" "/opt/spawn-app/.env_secrets" ];
    };
    unitConfig.OnFailure = "spawn-alerter@%n.service";
  };

  systemd.services.cert-renew = {
    description = "Renew Let's Encrypt certificate (webroot) and reload nginx";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    path = [ pkgs.certbot pkgs.procps ];
    serviceConfig.Type = "oneshot";
    script = ''certbot renew --quiet --deploy-hook "pkill -HUP -x nginx || true"'';
    unitConfig.OnFailure = "spawn-alerter@%n.service";
  };
  systemd.timers.cert-renew = {
    description = "Twice-daily Let's Encrypt renewal check";
    wantedBy = [ "timers.target" ];
    timerConfig = { OnCalendar = "*-*-* 03,15:17:00"; RandomizedDelaySec = "30m"; Persistent = true; };
  };

  systemd.services.spawn-healthcheck = {
    description = "spawn.os.moda health self-heal";
    path = [ pkgs.curl pkgs.openssh pkgs.procps pkgs.coreutils pkgs.gnugrep pkgs.systemd pkgs.openssl spawn-alert ];
    serviceConfig.Type = "oneshot";
    script = ''
      set +e
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:3000/api/plans)
      if [ "$code" != "200" ]; then
        echo "[selfheal] spawn-app unhealthy (HTTP $code) — restarting"
        systemctl restart spawn-app
        spawn-alert "🛠 self-heal: restarted spawn-app (was HTTP $code)" || true
      fi
      served_end=$(echo | openssl s_client -servername spawn.os.moda -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
      disk_end=$(openssl x509 -enddate -noout -in /etc/letsencrypt/live/spawn.os.moda/fullchain.pem 2>/dev/null | cut -d= -f2)
      if [ -n "$served_end" ] && [ -n "$disk_end" ] && [ "$served_end" != "$disk_end" ]; then
        echo "[selfheal] served cert ($served_end) != on-disk ($disk_end) — reloading nginx"
        pkill -HUP -x nginx || true
        spawn-alert "🛠 self-heal: HUPed nginx (served cert stale vs on-disk)" || true
      fi
    '';
    unitConfig.OnFailure = "spawn-alerter@%n.service";
  };
  systemd.timers.spawn-healthcheck = {
    description = "spawn.os.moda health self-heal (every 5 min)";
    wantedBy = [ "timers.target" ];
    timerConfig = { OnBootSec = "2min"; OnUnitActiveSec = "5min"; };
  };

  systemd.services."spawn-alerter@" = {
    description = "Telegram alert (instance = failing unit name)";
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${spawn-alert}/bin/spawn-alert ⚠️ unit %i failed";
    };
  };

  systemd.services.cert-monitor = {
    description = "Alert when TLS cert is within 10 days of expiry";
    path = [ pkgs.openssl pkgs.coreutils spawn-alert ];
    serviceConfig.Type = "oneshot";
    script = ''
      end=$(openssl x509 -enddate -noout -in /etc/letsencrypt/live/spawn.os.moda/fullchain.pem 2>/dev/null | cut -d= -f2)
      if [ -z "$end" ]; then echo "[cert-monitor] cert file missing"; exit 0; fi
      end_epoch=$(date -d "$end" +%s)
      now_epoch=$(date +%s)
      days=$(( (end_epoch - now_epoch) / 86400 ))
      echo "[cert-monitor] cert expires in $days days ($end)"
      if [ "$days" -lt 10 ]; then
        spawn-alert "⚠️ TLS cert for spawn.os.moda expires in $days days ($end) — check cert-renew.service"
      fi
    '';
  };
  systemd.timers.cert-monitor = {
    description = "Daily TLS cert expiry check";
    wantedBy = [ "timers.target" ];
    timerConfig = { OnCalendar = "*-*-* 08:23:00"; Persistent = true; };
  };

  systemd.services.spawn-backup = {
    description = "Daily encrypted off-box backup of /opt/spawn-app/data";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    path = [ spawn-backup pkgs.coreutils ];
    serviceConfig.Type = "oneshot";
    script = ''spawn-backup'';
    unitConfig.OnFailure = "spawn-alerter@%n.service";
  };
  systemd.timers.spawn-backup = {
    description = "Daily encrypted off-box backup";
    wantedBy = [ "timers.target" ];
    timerConfig = { OnCalendar = "*-*-* 04:13:00"; RandomizedDelaySec = "30m"; Persistent = true; };
  };

  networking.firewall.allowedTCPPorts = [ 22 ];
  system.stateVersion = "23.11";
  virtualisation.docker.enable = true;
  virtualisation.docker.logDriver = "json-file";
}
