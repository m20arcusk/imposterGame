'use client';

import { useState, FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useWebSocket } from '../lib/WebSocketContext';
import PersonIcon from '@mui/icons-material/Person';
import LogoutIcon from '@mui/icons-material/Logout';

export default function Lobby() {
    const { gameState, sendMessage, username } = useWebSocket();
    const { users, codeAck } = gameState;
    const canStart = users.length >= 3;
    const [codeInput, setCodeInput] = useState('');

    const handleStartRound = () => sendMessage('START_ROUND');
    const handleEndGame = () => sendMessage('END_GAME');
    const handleDisconnect = () => sendMessage('LEAVE_SESSION');

    const handleCodeSubmit = (e: FormEvent) => {
        e.preventDefault();
        const text = codeInput.trim();
        if (!text) return;
        sendMessage('CODE', { text });
        setCodeInput('');
    };

    return (
        <div className="flex flex-col h-full p-4 max-w-lg mx-auto">
            <div className="relative mb-2 shrink-0">
                <button
                    type="button"
                    onClick={handleEndGame}
                    title="End game for everyone"
                    className="absolute top-0 right-0 z-10 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-900/60
                               text-red-300/90 hover:bg-red-950/50 transition-colors"
                >
                    End game
                </button>
                <h2 className="text-2xl font-bold text-center pr-20">Lobby</h2>
                <p className="text-gray-400 text-center text-sm mt-0.5">
                    {users.length} player{users.length !== 1 ? 's' : ''} connected
                </p>
            </div>

            <form onSubmit={handleCodeSubmit} className="mb-4 flex gap-2 shrink-0">
                <input
                    type="text"
                    value={codeInput}
                    onChange={(e) => setCodeInput(e.target.value)}
                    placeholder="Enter the code here"
                    autoComplete="off"
                    className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm
                               focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
                />
                <motion.button
                    type="submit"
                    whileTap={{ scale: 0.97 }}
                    className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium"
                >
                    Code
                </motion.button>
            </form>
            {codeAck && (
                <p className="text-green-400/90 text-center text-xs mb-4 px-2 shrink-0">Code Accepted</p>
            )}

            <div className="flex-1 space-y-2 overflow-y-auto mb-6 min-h-0">
                <AnimatePresence mode="popLayout">
                    {users.map((user) => (
                        <motion.div
                            key={user.username}
                            layout
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20 }}
                            className="flex items-center gap-3 bg-gray-900 rounded-xl px-4 py-3 border border-gray-800"
                        >
                            <PersonIcon sx={{ color: user.color, fontSize: 28 }} />
                            <span className="flex-1 font-medium text-lg" style={{ color: user.color }}>
                                {user.username}
                                {user.username === username && (
                                    <span className="text-gray-500 text-sm ml-2">(you)</span>
                                )}
                            </span>
                            <span className="text-gray-400 font-mono text-sm bg-gray-800 px-2 py-1 rounded-lg">
                                {user.score} pts
                            </span>
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>

            <div className="space-y-3 shrink-0">
                <motion.button
                    whileHover={canStart ? { scale: 1.02 } : {}}
                    whileTap={canStart ? { scale: 0.98 } : {}}
                    onClick={handleStartRound}
                    disabled={!canStart}
                    className="w-full py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-700
                               disabled:text-gray-500 rounded-xl text-lg font-semibold transition-colors"
                    title={canStart ? 'Start the round' : 'Need at least 3 players'}
                >
                    {canStart ? 'Start Round' : `Need ${3 - users.length} more player${3 - users.length !== 1 ? 's' : ''}`}
                </motion.button>

                <motion.button
                    type="button"
                    whileTap={{ scale: 0.98 }}
                    onClick={handleDisconnect}
                    title="Leave the lobby (you can rejoin with your name)"
                    className="w-full py-2.5 flex items-center justify-center gap-2 rounded-xl border border-gray-700
                               text-gray-300 hover:bg-gray-800/80 text-sm font-medium transition-colors"
                >
                    <LogoutIcon sx={{ fontSize: 18 }} />
                    Disconnect
                </motion.button>
            </div>
        </div>
    );
}
