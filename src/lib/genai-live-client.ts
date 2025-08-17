/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  Content,
  GoogleGenAI,
  LiveCallbacks,
  LiveClientToolResponse,
  LiveConnectConfig,
  LiveServerContent,
  LiveServerMessage,
  LiveServerToolCall,
  LiveServerToolCallCancellation,
  Part,
  Session,
} from "@google/genai";

import { EventEmitter } from "eventemitter3";
import { difference } from "lodash";
import { LiveClientOptions, StreamingLog } from "../types";
import { base64ToArrayBuffer } from "./utils";

// Define our system command pattern to avoid magic strings
const SYSTEM_COMMAND_PATTERN = /^\[SYSTEM_ANALYSIS_MODE\]/;

/**
 * Event types that can be emitted by the MultimodalLiveClient.
 * Each event corresponds to a specific message from GenAI or client state change.
 */
export interface LiveClientEventTypes {
  // Emitted when audio data is received
  audio: (data: ArrayBuffer) => void;
  // Emitted when the connection closes
  close: (event: CloseEvent) => void;
  // Emitted when content is received from the server
  content: (data: LiveServerContent) => void;
  // Emitted when an error occurs
  error: (error: ErrorEvent) => void;
  // Emitted when the server interrupts the current generation
  interrupted: () => void;
  // Emitted for logging events
  log: (log: StreamingLog) => void;
  // Emitted when the connection opens
  open: () => void;
  // Emitted when the initial setup is complete
  setupcomplete: () => void;
  // Emitted when a tool call is received
  toolcall: (toolCall: LiveServerToolCall) => void;
  // Emitted when a tool call is cancelled
  toolcallcancellation: (
    toolcallCancellation: LiveServerToolCallCancellation,
  ) => void;
  // Emitted when the current turn is complete
  turncomplete: () => void;
}

/**
 * A event-emitting class that manages the connection to the websocket and emits
 * events to the rest of the application.
 * If you dont want to use react you can still use this.
 */
export class GenAILiveClient extends EventEmitter<LiveClientEventTypes> {
  protected client: GoogleGenAI;

  private _status: "connected" | "disconnected" | "connecting" = "disconnected";
  public get status() {
    return this._status;
  }

  private _session: Session | null = null;
  public get session() {
    return this._session;
  }

  private _model: string | null = null;
  public get model() {
    return this._model;
  }

  protected config: LiveConnectConfig | null = null;

  // Session resumption properties
  private resumptionHandle: string | null = null;
  private autoReconnectEnabled: boolean = true;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 1000; // 1 second initial delay

  public getConfig() {
    return { ...this.config };
  }

  constructor(options: LiveClientOptions) {
    super();
    this.client = new GoogleGenAI(options);
    this.send = this.send.bind(this);
    this.onopen = this.onopen.bind(this);
    this.onerror = this.onerror.bind(this);
    this.onclose = this.onclose.bind(this);
    this.onmessage = this.onmessage.bind(this);
  }

  protected log(type: string, message: StreamingLog["message"]) {
    const log: StreamingLog = {
      date: new Date(),
      type,
      message,
    };
    this.emit("log", log);
  }

  async connect(model: string, config: LiveConnectConfig): Promise<boolean> {
    if (this._status === "connected" || this._status === "connecting") {
      return false;
    }

    this._status = "connecting";
    this.config = config;
    this._model = model;

    // Enable session resumption and context window compression
    const enhancedConfig = {
      ...config,
      sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : undefined,
      contextWindowCompression: { slidingWindow: {} },
    };

    const callbacks: LiveCallbacks = {
      onopen: this.onopen,
      onmessage: this.onmessage,
      onerror: this.onerror,
      onclose: this.onclose,
    };

    try {
      this._session = await this.client.live.connect({
        model,
        config: enhancedConfig,
        callbacks,
      });
    } catch (e) {
      console.error("Error connecting to GenAI Live:", e);
      this._status = "disconnected";
      
      // If this was a reconnection attempt, try again with exponential backoff
      if (this.autoReconnectEnabled && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
        return false;
      }
      
      return false;
    }

    this._status = "connected";
    this.reconnectAttempts = 0; // Reset on successful connection
    return true;
  }

  public disconnect() {
    if (!this.session) {
      return false;
    }
    this.session?.close();
    this._session = null;
    this._status = "disconnected";

    this.log("client.close", `Disconnected`);
    return true;
  }

  protected onopen() {
    this.log("client.open", "Connected");
    this.emit("open");
  }

  protected onerror(e: ErrorEvent) {
    this.log("server.error", e.message);
    this.emit("error", e);
  }

  protected onclose(e: CloseEvent) {
    this.log(
      `server.close`,
      `disconnected ${e.reason ? `with reason: ${e.reason}` : ``}`,
    );
    
    // Set status to disconnected
    this._status = "disconnected";
    this._session = null;
    
    // Auto-reconnect if enabled and this wasn't a manual disconnect
    if (this.autoReconnectEnabled && e.code !== 1000) { // 1000 = normal closure
      console.log(`🔄 Connection lost (${e.reason || 'Unknown reason'}). Attempting auto-reconnection...`);
      this.scheduleReconnect();
    }
    
    this.emit("close", e);
  }

  protected async onmessage(message: LiveServerMessage) {
    if (message.setupComplete) {
      this.log("server.send", "setupComplete");
      this.emit("setupcomplete");
      return;
    }
    
    // Handle GoAway messages (connection about to terminate)
    if ((message as any).goAway) {
      const timeLeft = (message as any).goAway.timeLeft;
      this.log("server.goaway", `Connection terminating in ${timeLeft}`);
      console.log(`⚠️ Connection will terminate in ${timeLeft}. Preparing for auto-reconnection...`);
      
      // Schedule reconnection before the connection terminates
      if (this.autoReconnectEnabled && timeLeft) {
        const timeLeftMs = parseInt(timeLeft.toString());
        if (!isNaN(timeLeftMs)) {
          setTimeout(() => {
            if (this._status === "connected") {
              this.attemptReconnection();
            }
          }, Math.max(0, timeLeftMs - 1000)); // Reconnect 1 second before termination
        }
      }
      return;
    }
    
    // Handle session resumption updates
    if ((message as any).sessionResumptionUpdate) {
      const resumptionUpdate = (message as any).sessionResumptionUpdate;
      if (resumptionUpdate.resumable && resumptionUpdate.newHandle) {
        this.resumptionHandle = resumptionUpdate.newHandle;
        this.log("server.resumption", `New resumption handle: ${this.resumptionHandle}`);
        console.log(`📝 Session resumption handle updated: ${this.resumptionHandle?.slice(0, 20) || 'unknown'}...`);
      }
      return;
    }
    
    if (message.toolCall) {
      this.log("server.toolCall", message);
      this.emit("toolcall", message.toolCall);
      return;
    }
    if (message.toolCallCancellation) {
      this.log("server.toolCallCancellation", message);
      this.emit("toolcallcancellation", message.toolCallCancellation);
      return;
    }

    if (message.serverContent) {
      const { serverContent } = message;
      if ("interrupted" in serverContent) {
        this.log("server.content", "interrupted");
        this.emit("interrupted");
        return;
      }
      if ("turnComplete" in serverContent) {
        this.log("server.content", "turnComplete");
        this.emit("turncomplete");
      }

      if ("modelTurn" in serverContent) {
        let parts: Part[] = serverContent.modelTurn?.parts || [];
        const audioParts = parts.filter(
          (p) => p.inlineData && p.inlineData.mimeType?.startsWith("audio/pcm"),
        );
        const base64s = audioParts.map((p) => p.inlineData?.data);
        const otherParts = difference(parts, audioParts);

        base64s.forEach((b64) => {
          if (b64) {
            const data = base64ToArrayBuffer(b64);
            this.emit("audio", data);
            this.log(`server.audio`, `buffer (${data.byteLength})`);
          }
        });
        if (!otherParts.length) {
          return;
        }

        parts = otherParts;

        const content: { modelTurn: Content } = { modelTurn: { parts } };
        this.emit("content", content);
        this.log(`server.content`, message);
      }
    } else {
      console.log("received unmatched message", message);
    }
  }

  /**
   * send realtimeInput, this is base64 chunks of "audio/pcm" and/or "image/jpg"
   */
  sendRealtimeInput(chunks: Array<{ mimeType: string; data: string }>) {
    let hasAudio = false;
    let hasVideo = false;
    for (const ch of chunks) {
      this.session?.sendRealtimeInput({ media: ch });
      if (ch.mimeType.includes("audio")) {
        hasAudio = true;
      }
      if (ch.mimeType.includes("image")) {
        hasVideo = true;
      }
      if (hasAudio && hasVideo) {
        break;
      }
    }
    const message =
      hasAudio && hasVideo
        ? "audio + video"
        : hasAudio
          ? "audio"
          : hasVideo
            ? "video"
            : "unknown";
    this.log(`client.realtimeInput`, message);
  }

  /**
   *  send a response to a function call and provide the id of the functions you are responding to
   */
  sendToolResponse(toolResponse: LiveClientToolResponse) {
    if (
      toolResponse.functionResponses &&
      toolResponse.functionResponses.length
    ) {
      this.session?.sendToolResponse({
        functionResponses: toolResponse.functionResponses,
      });
      this.log(`client.toolResponse`, toolResponse);
    }
  }

  /**
   * send normal content parts such as { text }
   */
  send(parts: Part | Part[], turnComplete: boolean = true) {
    this.session?.sendClientContent({ turns: parts, turnComplete });

    // Convert parts to an array to handle both single and multiple parts
    const partArray = Array.isArray(parts) ? parts : [parts];

    // Check if the message being sent is our specific system command
    const isSystemCommand =
      partArray.length > 0 && 
      partArray[0].text && 
      SYSTEM_COMMAND_PATTERN.test(partArray[0].text);

    // Always log messages to the UI for debugging heartbeats
    this.log(`client.send`, {
      turns: partArray,
      turnComplete,
    });
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`❌ Max reconnection attempts (${this.maxReconnectAttempts}) reached. Auto-reconnection disabled.`);
      this.autoReconnectEnabled = false;
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    
    console.log(`⏱️ Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
    
    setTimeout(() => {
      this.attemptReconnection();
    }, delay);
  }

  /**
   * Attempt to reconnect with the same configuration
   */
  private async attemptReconnection() {
    if (!this.config || !this._model) {
      console.error("❌ Cannot reconnect: Missing configuration or model");
      return;
    }

    console.log(`🔄 Attempting reconnection with session resumption...`);
    
    try {
      const success = await this.connect(this._model, this.config);
      if (success) {
        console.log(`✅ Successfully reconnected! Session resumed.`);
        this.emit("setupcomplete"); // Emit setup complete for UI to know we're ready
      }
    } catch (error) {
      console.error("❌ Reconnection failed:", error);
      if (this.autoReconnectEnabled && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Enable or disable auto-reconnection
   */
  public setAutoReconnect(enabled: boolean) {
    this.autoReconnectEnabled = enabled;
    if (!enabled) {
      this.reconnectAttempts = 0;
    }
    console.log(`🔧 Auto-reconnection ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get current reconnection status
   */
  public getReconnectionStatus() {
    return {
      enabled: this.autoReconnectEnabled,
      attempts: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      hasResumptionHandle: !!this.resumptionHandle,
    };
  }
}
