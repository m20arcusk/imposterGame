'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useWebSocket } from '../lib/WebSocketContext';

export default function Voting() {
    const { gameState, sendMessage, username } = useWebSocket();
    const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
    const submitted = gameState.voteConfirmed;

    const handleVote = () => {
        if (!selectedTarget || submitted) return;
        sendMessage('VOTE', { username, target: selectedTarget });
    };

    const handleReturnToLobby = () => sendMessage('RETURN_TO_LOBBY', { force: true });

    return (
        <div className="flex flex-col h-full px-6 py-4 max-w-lg mx-auto">
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                <p className="text-gray-400 text-sm uppercase tracking-wider text-center mb-1">
                    The Question Was
                </p>
                <h2 className="text-xl font-bold text-center mb-6">
                    {gameState.correctQuestion}
                </h2>
            </motion.div>

            {!submitted ? (
                <>
                    <p className="text-gray-400 text-sm text-center mb-4">
                        Who do you think is the imposter?
                    </p>

                    <div className="flex-1 grid grid-cols-2 gap-3 auto-rows-min overflow-y-auto mb-4 p-2">
                        {gameState.answers?.map((a, i) => {
                            const isOwn = a.username === username;
                            const isSelected = selectedTarget === a.username;
                            const userColor = gameState.users.find((u) => u.username === a.username)?.color ?? '#888';

                            return (
                                <motion.button
                                    key={a.username}
                                    initial={{ opacity: 0, scale: 0.9 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    transition={{ delay: i * 0.05 }}
                                    onClick={() => !isOwn && setSelectedTarget(a.username)}
                                    disabled={isOwn}
                                    className={`
                                        p-4 rounded-xl text-left transition-all min-h-[88px]
                                        ${isOwn
                                            ? 'bg-gray-800/50 opacity-50 cursor-not-allowed'
                                            : isSelected
                                                ? 'bg-white/10 ring-2 ring-blue-500'
                                                : 'bg-gray-800 hover:bg-gray-750 active:scale-[0.97]'
                                        }
                                    `}
                                >
                                    <p className="text-white text-lg font-medium mb-2">
                                        &ldquo;{a.answer || '—'}&rdquo;
                                    </p>
                                    <p className="text-sm font-medium" style={{ color: userColor }}>
                                        {a.username}
                                        {isOwn && <span className="text-gray-500 ml-1">(you)</span>}
                                    </p>
                                </motion.button>
                            );
                        })}
                    </div>

                    <motion.button
                        whileHover={selectedTarget ? { scale: 1.02 } : {}}
                        whileTap={selectedTarget ? { scale: 0.98 } : {}}
                        onClick={handleVote}
                        disabled={!selectedTarget}
                        className="w-full py-3 bg-red-600 hover:bg-red-500 disabled:bg-gray-700
                                   disabled:text-gray-500 rounded-xl text-lg font-semibold transition-colors"
                    >
                        {selectedTarget ? `Vote for ${selectedTarget}` : 'Select a player'}
                    </motion.button>
                </>
            ) : (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex-1 flex flex-col items-center justify-center"
                >
                    <div className="inline-flex items-center gap-2 text-green-400 mb-2">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                            <path
                                fillRule="evenodd"
                                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                clipRule="evenodd"
                            />
                        </svg>
                        Vote submitted!
                    </div>
                    <p className="text-gray-400 text-sm">Waiting for other votes...</p>
                    <motion.div className="mt-3 h-1 w-16 bg-gray-700 rounded-full overflow-hidden">
                        <motion.div
                            className="h-full bg-red-500 rounded-full"
                            animate={{ x: ['-100%', '100%'] }}
                            transition={{ repeat: Infinity, duration: 1.5, ease: 'easeInOut' }}
                            style={{ width: '50%' }}
                        />
                    </motion.div>
                </motion.div>
            )}

            <button
                onClick={handleReturnToLobby}
                className="mt-4 py-2 text-gray-500 hover:text-gray-300 text-sm transition-colors text-center"
            >
                Return to Lobby
            </button>
        </div>
    );
}
