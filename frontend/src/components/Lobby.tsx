'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useWebSocket } from '../lib/WebSocketContext';
import PersonIcon from '@mui/icons-material/Person';

export default function Lobby() {
    const { gameState, sendMessage, username } = useWebSocket();
    const { users } = gameState;
    const canStart = users.length >= 3;

    const handleStartRound = () => sendMessage('START_ROUND');
    const handleEndGame = () => sendMessage('END_GAME');

    return (
        <div className="flex flex-col h-full p-4 max-w-lg mx-auto">
            <h2 className="text-2xl font-bold text-center mb-1">Lobby</h2>
            <p className="text-gray-400 text-center text-sm mb-6">
                {users.length} player{users.length !== 1 ? 's' : ''} connected
            </p>

            <div className="flex-1 space-y-2 overflow-y-auto mb-6">
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

            <div className="space-y-3">
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

                <button
                    onClick={handleEndGame}
                    className="w-full py-2 text-gray-400 hover:text-red-400 text-sm transition-colors"
                >
                    End Game
                </button>
            </div>
        </div>
    );
}
