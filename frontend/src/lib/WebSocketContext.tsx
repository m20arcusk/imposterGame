'use client';

import React, { createContext, useContext, useReducer, useRef, useCallback, useEffect, useState } from 'react';
import { GameState, ServerMessage } from './types';
import { gameReducer, initialGameState } from './gameReducer';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? '';

type WebSocketContextValue = {
    gameState: GameState;
    username: string | null;
    connected: boolean;
    joined: boolean;
    error: string | null;
    sendMessage: (action: string, payload?: Record<string, unknown>) => void;
    clearError: () => void;
};

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

export function useWebSocket() {
    const ctx = useContext(WebSocketContext);
    if (!ctx) throw new Error('useWebSocket must be used within WebSocketProvider');
    return ctx;
}

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
    const [gameState, dispatch] = useReducer(gameReducer, initialGameState);
    const [connected, setConnected] = useState(false);
    const [joined, setJoined] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [username, setUsername] = useState<string | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const retryRef = useRef(0);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const intentionalCloseRef = useRef(false);
    const usernameRef = useRef<string | null>(null);
    const joinedRef = useRef(false);

    const clearError = useCallback(() => setError(null), []);

    const sendMessage = useCallback((action: string, payload: Record<string, unknown> = {}) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ action, ...payload }));
        }
    }, []);

    const connectWs = useCallback((user: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
            return;
        }

        intentionalCloseRef.current = false;
        usernameRef.current = user;

        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
            setConnected(true);
            retryRef.current = 0;
            setUsername(user);
            const storedToken = localStorage.getItem('imposter_session_token');
            const joinPayload: Record<string, string> = { action: 'JOIN_SESSION', username: user };
            if (storedToken) joinPayload.sessionToken = storedToken;
            ws.send(JSON.stringify(joinPayload));
        };

        ws.onmessage = (evt) => {
            try {
                const msg: ServerMessage = JSON.parse(evt.data);
                if (msg.type === 'ERROR') {
                    setError(msg.message);
                    if (!joinedRef.current) {
                        sessionStorage.setItem('imposter_join_error', msg.message);
                        localStorage.removeItem('imposter_username');
                        localStorage.removeItem('imposter_session_token');
                        setUsername(null);
                        intentionalCloseRef.current = true;
                        ws.close();
                    }
                } else if (msg.type === 'JOIN_CONFIRMED') {
                    joinedRef.current = true;
                    setJoined(true);
                    setError(null);
                    if (msg.sessionToken) {
                        localStorage.setItem('imposter_session_token', msg.sessionToken);
                    }
                    dispatch(msg);
                } else if (msg.type === 'GAME_ENDED' || msg.type === 'LEFT_SESSION') {
                    dispatch(msg);
                    localStorage.removeItem('imposter_username');
                    localStorage.removeItem('imposter_session_token');
                    setUsername(null);
                    setJoined(false);
                    joinedRef.current = false;
                    intentionalCloseRef.current = true;
                    ws.close();
                } else if (msg.type === 'CODE_OK') {
                    setError(null);
                    dispatch(msg);
                } else {
                    setError(null);
                    dispatch(msg);
                }
            } catch {
                // ignore malformed messages
            }
        };

        ws.onclose = () => {
            // Ignore closes from a replaced socket (React Strict Mode remount, reconnect, etc.)
            if (wsRef.current !== ws) {
                return;
            }
            wsRef.current = null;
            setConnected(false);
            if (!intentionalCloseRef.current && usernameRef.current) {
                const delay = Math.min(1000 * Math.pow(2, retryRef.current), 10000);
                retryRef.current += 1;
                retryTimerRef.current = setTimeout(() => connectWs(usernameRef.current!), delay);
            }
        };

        ws.onerror = () => {
            ws.close();
        };
    }, []);

    useEffect(() => {
        const storedUsername = localStorage.getItem('imposter_username');
        if (storedUsername) {
            connectWs(storedUsername);
        }
        return () => {
            intentionalCloseRef.current = true;
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
            const socket = wsRef.current;
            wsRef.current = null;
            socket?.close();
        };
    }, [connectWs]);

    return (
        <WebSocketContext.Provider value={{ gameState, username, connected, joined, error, sendMessage, clearError }}>
            {children}
        </WebSocketContext.Provider>
    );
}
