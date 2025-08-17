
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

import { useRef, useState } from "react";
import "./App.scss";
import { LiveAPIProvider, useLiveAPIContext } from "./contexts/LiveAPIContext";
import SidePanel from "./components/side-panel/SidePanel";
import CoachSetup from "./components/coach/CoachSetup";
import ControlTray from "./components/control-tray/ControlTray";
import cn from "classnames";
import { LiveClientOptions } from "./types";

const API_KEY = process.env.REACT_APP_GEMINI_API_KEY as string;
if (typeof API_KEY !== "string") {
  throw new Error("set REACT_APP_GEMINI_API_KEY in .env");
}

const apiOptions: LiveClientOptions = {
  apiKey: API_KEY,
};

type Game = "EAFC" | "League of Legends" | "Street Fighter 6" | null;

function AppContent() {
  const { connected } = useLiveAPIContext();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [activeGame, setActiveGame] = useState<Game>(null);
  const [playerName, setPlayerName] = useState<string>("");
  const [isPlayerNameSet, setIsPlayerNameSet] = useState<boolean>(false);

  const handleGameSelect = (game: Game) => {
    setActiveGame(game);
    setIsPlayerNameSet(false); // Reset player name step when changing games
  };

  const handlePlayerNameSubmit = () => {
    if (playerName.trim()) {
      setIsPlayerNameSet(true);
      // Dispatch custom event for CoachSetup to listen to
      window.dispatchEvent(new CustomEvent('gameSelected', { 
        detail: { 
          game: activeGame, 
          playerName: playerName.trim() 
        } 
      }));
    }
  };

  const gameInfo = {
    "EAFC": {
      title: "EA FC 25",
      description: "Football tactics, positioning, and strategy coaching",
      color: "#00d4ff"
    },
    "League of Legends": {
      title: "League of Legends",
      description: "MOBA strategy, mechanics, and macro play coaching",
      color: "#c8aa6e"
    },
    "Street Fighter 6": {
      title: "Street Fighter 6",
      description: "Fighting game fundamentals, combos, and neutral coaching",
      color: "#ff6b35"
    }
  };

  const GameSelector = () => (
    <div className="game-selector">
      <div className="game-selector-header">
        <h2>Choose Your Game</h2>
        <p>Select the game you want to improve at for specialized coaching</p>
      </div>
      <div className="game-cards">
        {(Object.keys(gameInfo) as Array<keyof typeof gameInfo>).map((game) => (
          <div
            key={game}
            className={cn("game-card", { active: activeGame === game })}
            onClick={() => handleGameSelect(game)}
            style={{ borderColor: activeGame === game ? gameInfo[game].color : undefined }}
          >
            <div className="game-card-content">
              <h3 style={{ color: gameInfo[game].color }}>{gameInfo[game].title}</h3>
              <p>{gameInfo[game].description}</p>
            </div>
            {activeGame === game && (
              <div className="game-card-selected" style={{ backgroundColor: gameInfo[game].color }}>
                <span className="material-symbols-outlined">check_circle</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  const PlayerNameInput = () => (
    <div className="player-name-input">
      <div className="player-name-header">
        <h2>What's your player name in {gameInfo[activeGame!].title}?</h2>
        <p>This helps me focus on your character and provide personalized coaching</p>
      </div>
      <div className="player-name-form">
        <input
          type="text"
          placeholder="Enter your in-game player name..."
          value={playerName}
          onChange={(e) => setPlayerName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && playerName.trim()) {
              handlePlayerNameSubmit();
            }
          }}
          className="player-name-field"
          autoFocus
        />
        <button
          onClick={handlePlayerNameSubmit}
          disabled={!playerName.trim()}
          className="player-name-submit"
          style={{ backgroundColor: playerName.trim() ? gameInfo[activeGame!].color : undefined }}
        >
          Start Coaching
        </button>
      </div>
      <div className="player-name-back">
        <button onClick={() => setActiveGame(null)} className="back-button">
          ← Choose Different Game
        </button>
      </div>
    </div>
  );

  return (
    <>
      <CoachSetup />
      <div className="streaming-console">
        <SidePanel />
        <main>
          <div className="main-app-area">
            {!activeGame && <GameSelector />}
            {activeGame && !isPlayerNameSet && <PlayerNameInput />}
            {activeGame && isPlayerNameSet && !connected && (
              <div className="connection-prompt">
                <h2>Perfect! Now hit the blue play button!</h2>
                <p>Connect to your AI {gameInfo[activeGame].title} coach to get started</p>
                <div className="player-info">
                  <p>Coaching player: <strong>{playerName}</strong></p>
                </div>
              </div>
            )}
            {connected && activeGame && !videoStream && (
              <div className="streaming-ready">
                <h2>Ready to coach {playerName} in {gameInfo[activeGame].title}!</h2>
                <p>Start screen sharing to begin live coaching</p>
              </div>
            )}
            <video
              className={cn("stream", {
                hidden: !videoRef.current || !videoStream,
              })}
              ref={videoRef}
              autoPlay
              playsInline
            />
          </div>
          <ControlTray
            videoRef={videoRef}
            supportsVideo={true}
            onVideoStreamChange={setVideoStream}
            enableEditingSettings={true}
            videoStream={videoStream}
            activeGame={activeGame && isPlayerNameSet ? activeGame : null}
          >
            {/* put your own buttons here */}
          </ControlTray>
        </main>
      </div>
    </>
  );
}

function App() {
  return (
    <div className="App">
      <LiveAPIProvider options={apiOptions}>
        <AppContent />
      </LiveAPIProvider>
    </div>
  );
}

export default App;
