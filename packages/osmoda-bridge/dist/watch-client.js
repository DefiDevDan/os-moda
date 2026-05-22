"use strict";
/**
 * HTTP client for communicating with osmoda-watch over a Unix socket.
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
exports.watchRequest = watchRequest;
const http = __importStar(require("node:http"));
const WATCH_SOCKET = process.env.OSMODA_WATCH_SOCKET || "/run/osmoda/watch.sock";
function watchRequest(method, reqPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            socketPath: WATCH_SOCKET, path: reqPath, method,
            headers: {
                "Content-Type": "application/json",
                ...(payload ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
            },
            timeout: 30_000,
        }, (res) => {
            let data = "";
            res.on("data", (c) => { data += c.toString(); });
            res.on("end", () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`watch ${method} ${reqPath} returned ${res.statusCode}: ${data}`));
                    return;
                }
                resolve(data);
            });
        });
        req.on("error", (e) => reject(new Error(`watch connection failed: ${e.message}`)));
        req.on("timeout", () => { req.destroy(); reject(new Error("watch request timed out")); });
        if (payload)
            req.write(payload);
        req.end();
    });
}
