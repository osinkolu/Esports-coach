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

import cn from "classnames";
import { memo, ReactNode, RefObject, useEffect, useRef, useState } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { UseMediaStreamResult } from "../../hooks/use-media-stream-mux";
import { useScreenCapture } from "../../hooks/use-screen-capture";
import { useWebcam } from "../../hooks/use-webcam";
import { AudioRecorder } from "../../lib/audio-recorder";
import AudioPulse from "../audio-pulse/AudioPulse";
import "./control-tray.scss";
import SettingsDialog from "../settings-dialog/SettingsDialog";

type Game = "EAFC" | "League of Legends" | "Street Fighter 6" | null;

type MediaStreamButtonProps = {
  isStreaming: boolean;
  onIcon: string;
  offIcon: string;
  start: () => void;
  stop: () => void;
  disabled?: boolean;
};

export type ControlTrayProps = {
  videoRef: RefObject<HTMLVideoElement>;
  children?: ReactNode;
  supportsVideo: boolean;
  onVideoStreamChange?: (stream: MediaStream | null) => void;
  enableEditingSettings?: boolean;
  videoStream: MediaStream | null;
  activeGame: Game;
};

const MediaStreamButton = memo(
  ({
    isStreaming,
    onIcon,
    offIcon,
    start,
    stop,
    disabled = false,
  }: MediaStreamButtonProps) =>
    isStreaming ? (
      <button className="action-button" onClick={stop}>
        <span className="material-symbols-outlined">{onIcon}</span>
      </button>
    ) : (
      <button
        className={cn("action-button", { disabled })}
        onClick={disabled ? undefined : start}
        disabled={disabled}
        title={
          disabled ? "Select a game first to enable screen sharing" : undefined
        }
      >
        <span className="material-symbols-outlined">{offIcon}</span>
      </button>
    ),
);

function ControlTray({
  videoRef,
  children,
  onVideoStreamChange = () => {},
  supportsVideo,
  enableEditingSettings,
  videoStream,
  activeGame,
}: ControlTrayProps) {
  const videoStreams = [useWebcam(), useScreenCapture()];
  const [activeVideoStream, setActiveVideoStream] =
    useState<MediaStream | null>(null);
  const [webcam, screenCapture] = videoStreams;
  const [inVolume, setInVolume] = useState(0);
  const [audioRecorder] = useState(() => new AudioRecorder());
  const [muted, setMuted] = useState(false);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const connectButtonRef = useRef<HTMLButtonElement>(null);
  const [isAISpeaking, setIsAISpeaking] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const lastVolumeRef = useRef(0);
  
  // Track user speaking state and pause system commands during conversation
  const [lastUserSpeechTime, setLastUserSpeechTime] = useState<number>(0);

  // FIX: Restore the destructuring of all needed functions/variables
  const { client, connected, connect, disconnect, volume, config } =
    useLiveAPIContext();

  // Refs to track current state for heartbeat (avoid closure issues)
  const currentStateRef = useRef({
    connected: false,
    activeGame: null as Game,
    videoStream: null as MediaStream | null,
    activeVideoStream: null as MediaStream | null,
    isAISpeaking: false,
    isUserSpeaking: false,
    lastUserSpeechTime: 0
  });

  // Update refs whenever state changes
  useEffect(() => {
    currentStateRef.current = {
      connected,
      activeGame,
      videoStream,
      activeVideoStream,
      isAISpeaking,
      isUserSpeaking,
      lastUserSpeechTime
    };
  }, [connected, activeGame, videoStream, activeVideoStream, isAISpeaking, isUserSpeaking, lastUserSpeechTime]);

  // Track AI speaking state based on volume
  useEffect(() => {
    setIsAISpeaking(volume > 0.01);
  }, [volume]);

  // Track previous screen sharing state to detect changes
  const [wasScreenSharing, setWasScreenSharing] = useState(false);

  useEffect(() => {
    const volumeThreshold = 0.015; // Slightly more sensitive
    const currentlyUserSpeaking = inVolume > volumeThreshold;

    if (currentlyUserSpeaking !== isUserSpeaking) {
      setIsUserSpeaking(currentlyUserSpeaking);

      // Update last speech time when user starts speaking
      if (currentlyUserSpeaking) {
        setLastUserSpeechTime(Date.now());
      }
    }
    lastVolumeRef.current = inVolume;
  }, [inVolume, isUserSpeaking]);

  // Simplified Screen Sharing Detection with Heartbeat
  useEffect(() => {
    let tickInterval: NodeJS.Timeout;

    // Simple validation function
    const isScreenSharing = (): boolean => {
      return screenCapture.isStreaming || webcam.isStreaming;
    };

    const currentlyScreenSharing = isScreenSharing();

    // Detect screen sharing state changes and notify CoachSetup
    if (currentlyScreenSharing && !wasScreenSharing) {
      console.log(`Screen sharing started for ${activeGame}. Notifying CoachSetup.`);
      window.dispatchEvent(
        new CustomEvent("screenSharingStarted", {
          detail: { game: activeGame },
        }),
      );
      setWasScreenSharing(true);

      // Notify AI that screen sharing has started
      if (client && connected && !muted) {
        const screenShareNotification = `[SYSTEM_NOTIFICATION] SCREEN SHARING NOW ACTIVE - ${activeGame} COACHING MODE ENGAGED

I have successfully started screen sharing my ${activeGame} gameplay. You can now see my screen in real-time and should provide live coaching analysis.

**COACHING MODE ACTIVATED:**
- You are now watching live ${activeGame} gameplay footage
- Provide IMMEDIATE tactical guidance and corrections
- React to exciting moments and key gameplay events
- Give DIRECT commands and instructions
- Be authoritative and decisive in your coaching
- Only speak when you see something worth coaching about

**IMMEDIATE ACTION:** Start analyzing my gameplay and provide coaching when you see opportunities for improvement or exciting moments worth commenting on. Be direct, confident, and helpful.`;

        client.send([{ text: screenShareNotification }]);
        console.log("Sent screen sharing start notification to AI");
      }
    } else if (!currentlyScreenSharing && wasScreenSharing) {
      console.log(`Screen sharing stopped. Notifying CoachSetup.`);
      window.dispatchEvent(
        new CustomEvent("screenSharingStopped", {
          detail: { game: activeGame },
        }),
      );
      setWasScreenSharing(false);

      // Notify AI that screen sharing has stopped
      if (client && connected && !muted) {
        const screenShareStoppedNotification = `[SYSTEM_NOTIFICATION] I have stopped screen sharing. You can no longer see my screen.`;
        client.send([{ text: screenShareStoppedNotification }]);
        console.log("Sent screen sharing stop notification to AI");
      }
    }

    // Start heartbeat if screen sharing is active
    if (currentlyScreenSharing) {
      const heartbeatInterval = (config?.heartbeatInterval || 15) * 1000;
      console.log(`🚀 HEARTBEAT STARTING - Screen sharing active for ${activeGame}, interval: ${heartbeatInterval/1000}s`);
      
      tickInterval = setInterval(() => {
        console.log("🔄 HEARTBEAT TICK - Starting new cycle");
        
        // Check simplified conditions: 1. Screen sharing active, 2. User not speaking
        const screenSharingActive = isScreenSharing();
        const userNotSpeaking = !isUserSpeaking;

        console.log("HEARTBEAT CONDITIONS:", {
          screenSharingActive,
          userNotSpeaking,
          userSpeaking: isUserSpeaking,
          inVolume
        });

        if (screenSharingActive && userNotSpeaking) {
          console.log("🧠 OBSERVATION PHASE - Taking time to analyze screen content");
          
          // Add observation delay to allow proper screen analysis
          setTimeout(() => {
            console.log("📤 SENDING COACHING INSTRUCTION - After observation period");
            
            const coachingInstruction = `[SYSTEM_ANALYSIS_MODE] LIVE ${activeGame} SCREEN ANALYSIS - OBSERVATION & VERIFICATION REQUIRED

**🚨 CRITICAL SAFETY PROTOCOL - READ CAREFULLY 🚨**

**IMMEDIATE OBSERVATION REQUIREMENT:**
You MUST spend 5-7 seconds carefully observing the current screen before ANY response. Look at:
- What is actually visible on screen RIGHT NOW
- Are players moving on the field or is everything static?
- Can you see the game clock counting down?
- Are there any pause menu overlays or static screens?

**${activeGame} PAUSE DETECTION - CRITICAL:**
🟥 **PAUSED GAME INDICATORS - STAY SILENT IF YOU SEE ANY:**
   - Pause menu overlay (Settings, Resume, Quit options)
   - Static player positions with no movement for 3+ seconds
   - Menu screens (tactics, substitutions, team management)
   - Game clock not moving/counting
   - "PAUSED" text or pause symbol visible
   - Controller disconnected messages
   - Any overlay covering the gameplay
   - Players standing completely still with no ball movement

🟢 **ACTIVE GAMEPLAY INDICATORS - ONLY SPEAK IF YOU SEE:**
   - Players actively running/moving on the pitch
   - Ball in motion or being contested
   - Game clock visibly counting down
   - Continuous player animations and movement
   - Active ball physics (rolling, bouncing, being kicked)

**HALLUCINATION PREVENTION - MANDATORY CHECKS:**
⚠️ **WARNING: There are serious repercussions for giving wrong advice or hallucinating**
⚠️ **You must be 100% certain about what you observe before speaking**

**VERIFICATION CHECKLIST - ALL MUST BE TRUE TO SPEAK:**
1. ✅ **VERIFY ACTIVE GAMEPLAY**: Can you see players actively moving and the ball in play?
2. ✅ **VERIFY GAME CLOCK**: Is the game timer visibly counting down?
3. ✅ **VERIFY NO PAUSE OVERLAY**: No menu, pause screen, or overlay is visible?
4. ✅ **VERIFY COACHING OPPORTUNITY**: Is there a clear tactical situation happening right now?

**RESPONSE RULES - STRICTLY ENFORCE:**
✅ **SPEAK ONLY IF ALL FOUR VERIFICATION CHECKS PASS**

❌ **MANDATORY SILENCE IF ANY OF THESE ARE TRUE:**
   - Game appears paused (static players, no movement)
   - Any menu or overlay is visible
   - Players are not moving for more than 2-3 seconds
   - Game clock is not counting down
   - You see "PAUSED" or pause symbols
   - The screen content is unclear or you're uncertain
   - No clear coaching opportunity exists

**WHEN YOU DO SPEAK (ONLY DURING VERIFIED ACTIVE GAMEPLAY):**
- Reference specific movement: "I see your striker making a run"
- Reference ball position: "The ball is in your midfield"
- Give immediate actions: "Pass to the open player on the left"
- Reference specific visual elements you can clearly observe

**SAFETY OVERRIDE:**
If you have ANY uncertainty about whether the game is paused or active, default to COMPLETE SILENCE. Better to miss coaching opportunities than speak during paused gameplay.

**TEMPORAL CONTEXT**: Analyze the last 5-7 seconds of video to determine if you're seeing continuous active gameplay or static/paused content.`;

            console.log("Sending coaching instruction to AI...");
            client.send([{ text: coachingInstruction }]);
          }, 3500); // 3.5-second observation delay before sending instruction
          
        } else {
          if (!screenSharingActive) {
            console.log("⏸️ Skipping - Screen sharing not active");
          }
          if (!userNotSpeaking) {
            console.log("⏸️ Skipping - User is speaking");
          }
        }
        
        console.log("🔄 HEARTBEAT TICK - Cycle complete");
      }, (config?.heartbeatInterval || 15) * 1000);
    } else {
      console.log("Screen sharing not active. Heartbeat stopped.");
    }

    return () => {
      if (tickInterval) {
        console.log("🛑 HEARTBEAT STOPPING - Clearing interval");
        clearInterval(tickInterval);
      }
    };
  }, [
    connected,
    client,
    muted,
    activeGame,
    screenCapture.isStreaming,
    webcam.isStreaming,
    wasScreenSharing,
    isUserSpeaking,
    config?.heartbeatInterval,
  ]);

  useEffect(() => {
    if (!connected && connectButtonRef.current) {
      connectButtonRef.current.focus();
    }
  }, [connected]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--volume",
      `${Math.max(5, Math.min(inVolume * 200, 8))}px`,
    );
  }, [inVolume]);

  useEffect(() => {
    const onData = (base64: string) => {
      client.sendRealtimeInput([
        {
          mimeType: "audio/pcm;rate=16000",
          data: base64,
        },
      ]);
    };
    if (connected && !muted && audioRecorder) {
      audioRecorder.on("data", onData).on("volume", setInVolume).start();
    } else {
      audioRecorder.stop();
    }
    return () => {
      audioRecorder.off("data", onData).off("volume", setInVolume);
    };
  }, [connected, client, muted, audioRecorder]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = activeVideoStream;
    }

    let timeoutId = -1;

    function sendVideoFrame() {
      const video = videoRef.current;
      const canvas = renderCanvasRef.current;

      if (!video || !canvas) {
        return;
      }

      const ctx = canvas.getContext("2d")!;
      canvas.width = video.videoWidth * 0.25;
      canvas.height = video.videoHeight * 0.25;
      if (canvas.width + canvas.height > 0) {
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL("image/jpeg", 1.0);
        const data = base64.slice(base64.indexOf(",") + 1, Infinity);
        client.sendRealtimeInput([{ mimeType: "image/jpeg", data }]);
      }
      if (connected) {
        timeoutId = window.setTimeout(sendVideoFrame, 1000 / 0.5);
      }
    }
    if (connected && activeVideoStream !== null) {
      requestAnimationFrame(sendVideoFrame);
    }
    return () => {
      clearTimeout(timeoutId);
    };
  }, [connected, activeVideoStream, client, videoRef]);

  const changeStreams = (next?: UseMediaStreamResult) => async () => {
    console.log("🎬 SCREEN SHARE BUTTON CLICKED:", {
      nextStream: next?.constructor.name,
      isScreenCapture: next === screenCapture,
      currentScreenCaptureStreaming: screenCapture.isStreaming,
      activeGame: activeGame
    });
    
    if (next) {
      try {
        console.log("🚀 Starting stream...");
        const mediaStream = await next.start();
        console.log("✅ Stream started successfully:", {
          streamId: mediaStream?.id,
          streamActive: mediaStream?.active,
          tracks: mediaStream?.getTracks().length
        });
        setActiveVideoStream(mediaStream);
        onVideoStreamChange(mediaStream);
      } catch (error) {
        console.error("❌ Failed to start stream:", error);
      }
    } else {
      console.log("🛑 Stopping all streams");
      setActiveVideoStream(null);
      onVideoStreamChange(null);
    }

    videoStreams.filter((msr) => msr !== next).forEach((msr) => msr.stop());
  };

  return (
    <section className="control-tray">
      <canvas style={{ display: "none" }} ref={renderCanvasRef} />
      <nav className={cn("actions-nav", { disabled: !connected })}>
        <button
          className={cn("action-button mic-button")}
          onClick={() => setMuted(!muted)}
        >
          {!muted ? (
            <span className="material-symbols-outlined filled">mic</span>
          ) : (
            <span className="material-symbols-outlined filled">mic_off</span>
          )}
        </button>

        <div className="action-button no-action outlined">
          <AudioPulse volume={volume} active={connected} hover={false} />
        </div>

        {supportsVideo && (
          <>
            <MediaStreamButton
              isStreaming={screenCapture.isStreaming}
              start={changeStreams(screenCapture)}
              stop={changeStreams()}
              onIcon="cancel_presentation"
              offIcon="present_to_all"
              disabled={!activeGame}
            />
            <MediaStreamButton
              isStreaming={webcam.isStreaming}
              start={changeStreams(webcam)}
              stop={changeStreams()}
              onIcon="videocam_off"
              offIcon="videocam"
              disabled={!activeGame}
            />
          </>
        )}
        {children}
      </nav>

      <div className={cn("connection-container", { connected })}>
        <div className="connection-button-container">
          <button
            ref={connectButtonRef}
            className={cn("action-button connect-toggle", { 
              connected,
              disabled: !connected && !activeGame 
            })}
            onClick={connected ? disconnect : (activeGame ? connect : undefined)}
            disabled={!connected && !activeGame}
            title={!activeGame ? "Select a game first" : undefined}
          >
            <span className="material-symbols-outlined filled">
              {connected ? "pause" : "play_arrow"}
            </span>
          </button>
        </div>
        <span className="text-indicator">Streaming</span>
      </div>
      {enableEditingSettings ? <SettingsDialog /> : ""}
    </section>
  );
}

export default memo(ControlTray);