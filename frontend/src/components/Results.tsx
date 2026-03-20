'use client';

import { motion } from 'framer-motion';
import { useWebSocket } from '../lib/WebSocketContext';

export default function Results() {
    const { gameState, sendMessage } = useWebSocket();
    const result = gameState.result;

    if (!result) return null;

    const caught = result.success;

    const handleReturnToLobby = () => sendMessage('RETURN_TO_LOBBY');

    return (
        <div className="flex flex-col h-full p-4 max-w-lg mx-auto items-center justify-center">
            <motion.div
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'spring', duration: 0.6 }}
                className="text-center mb-8"
            >
                <motion.div
                    className="text-6xl mb-4"
                    initial={{ rotate: -10 }}
                    animate={{ rotate: 0 }}
                    transition={{ type: 'spring', stiffness: 200 }}
                >
                    {caught ? '🎉' : '😈'}
                </motion.div>

                <h1
                    className={`text-3xl font-bold mb-2 ${caught ? 'text-green-400' : 'text-red-400'}`}
                >
                    {caught ? 'The imposter was caught!' : 'The imposter has won!'}
                </h1>

                <p className="text-xl text-gray-300">
                    The imposter was{' '}
                    <span
                        className="font-bold"
                        style={{
                            color: gameState.users.find((u) => u.username === result.imposterUsername)?.color ?? '#fff',
                        }}
                    >
                        {result.imposterUsername}
                    </span>
                </p>
            </motion.div>

            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="w-full max-w-xs space-y-2 mb-8"
            >
                <p className="text-gray-400 text-sm text-center uppercase tracking-wider mb-2">
                    Scores
                </p>
                {result.updatedScores
                    .sort((a, b) => b.score - a.score)
                    .map((s) => {
                        const userColor = gameState.users.find((u) => u.username === s.username)?.color ?? '#888';
                        return (
                            <div
                                key={s.username}
                                className="flex items-center justify-between bg-gray-900 rounded-xl px-4 py-3 border border-gray-800"
                            >
                                <span className="font-medium" style={{ color: userColor }}>
                                    {s.username}
                                    {s.username === result.imposterUsername && (
                                        <span className="text-gray-500 text-xs ml-2">imposter</span>
                                    )}
                                </span>
                                <span className="font-mono text-gray-300 bg-gray-800 px-2 py-1 rounded-lg text-sm">
                                    {s.score} pts
                                </span>
                            </div>
                        );
                    })}
            </motion.div>

            <motion.button
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 }}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleReturnToLobby}
                className="w-full max-w-xs py-3 bg-blue-600 hover:bg-blue-500 rounded-xl
                           text-lg font-semibold transition-colors"
            >
                Return to Lobby
            </motion.button>
        </div>
    );
}
