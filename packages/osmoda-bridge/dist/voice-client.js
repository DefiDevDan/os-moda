"use strict";
/**
 * Voice daemon client — communicates with osmoda-voice over Unix socket.
 *
 * The voice daemon listens at /run/osmoda/voice.sock and provides
 * STT (whisper.cpp) and TTS (piper-tts) capabilities.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoiceClient = void 0;
const http = __importStar(require("node:http"));
class VoiceClient {
    socketPath;
    constructor(socketPath = "/run/osmoda/voice.sock") {
        this.socketPath = socketPath;
    }
    request(method, path, body) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : undefined;
            const options = {
                socketPath: this.socketPath,
                path,
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
                },
            };
            const req = http.request(options, (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(data));
                    }
                    catch {
                        resolve(data);
                    }
                });
            });
            req.on("error", (err) => {
                if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
                    reject(new Error(`Voice daemon not running (socket: ${this.socketPath})`));
                }
                else {
                    reject(err);
                }
            });
            if (payload) {
                req.write(payload);
            }
            req.end();
        });
    }
    async get(path) {
        return this.request("GET", path);
    }
    async post(path, body) {
        return this.request("POST", path, body);
    }
    /** Check if the voice daemon is reachable. */
    async isAvailable() {
        try {
            await this.get("/voice/status");
            return true;
        }
        catch {
            return false;
        }
    }
    async status() {
        return this.get("/voice/status");
    }
    async speak(text) {
        return this.post("/voice/speak", { text });
    }
    async transcribe(audioPath) {
        return this.post("/voice/transcribe", { audio_path: audioPath });
    }
    async record(durationSecs, transcribe) {
        return this.post("/voice/record", {
            duration_secs: durationSecs ?? 5,
            transcribe: transcribe ?? true,
        });
    }
    async setListening(enabled) {
        return this.post("/voice/listen", { enabled });
    }
}
exports.VoiceClient = VoiceClient;
