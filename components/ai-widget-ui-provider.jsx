"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  useAgentState,
  useClient,
  useConnectionState,
  useConversation,
} from "@telnyx/ai-agent-lib";
import {
  buildAIDiagnostics,
  getAIWidgetStatus,
} from "@/lib/ai/widget-ui-state.mjs";

const AIWidgetUIContext = createContext(null);

function getErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return "The assistant could not connect. Please try again.";
}

export function AIWidgetUIProvider({ children }) {
  const client = useClient();
  const connectionState = useConnectionState();
  const conversation = useConversation();
  const agentState = useAgentState();
  const [authState, setAuthState] = useState(() =>
    client?.isAuthenticated ? "authenticated" : "idle"
  );
  const [connectionInfo, setConnectionInfo] = useState(null);
  const [error, setError] = useState(null);
  const [canRetryConnection, setCanRetryConnection] = useState(false);
  const [isStartingConversation, setIsStartingConversation] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);

  const callState = conversation?.call?.state || null;
  const hasActiveConversation = callState === "active";

  useEffect(() => {
    if (!client) return;

    const handleLoginStarted = () => {
      setAuthState("authenticating");
      setError(null);
      setCanRetryConnection(false);
    };
    const handleLoginSuccess = () => {
      setAuthState("authenticated");
      setError(null);
      setCanRetryConnection(false);
    };
    const handleConnected = (info) => {
      setAuthState("authenticated");
      setConnectionInfo(info || null);
      setIsReconnecting(false);
      setError(null);
      setCanRetryConnection(false);
    };
    const handleDisconnected = () => {
      setAuthState("idle");
      setIsStartingConversation(false);
    };
    const handleError = (nextError) => {
      setAuthState("error");
      setIsStartingConversation(false);
      setIsReconnecting(false);
      setError(getErrorMessage(nextError));
      setCanRetryConnection(true);
    };

    client.on("agent.login.started", handleLoginStarted);
    client.on("agent.login.success", handleLoginSuccess);
    client.on("agent.connected", handleConnected);
    client.on("agent.disconnected", handleDisconnected);
    client.on("agent.error", handleError);

    if (client.isAuthenticated) setAuthState("authenticated");
    else if (client.isAuthenticating) setAuthState("authenticating");

    return () => {
      client.off("agent.login.started", handleLoginStarted);
      client.off("agent.login.success", handleLoginSuccess);
      client.off("agent.connected", handleConnected);
      client.off("agent.disconnected", handleDisconnected);
      client.off("agent.error", handleError);
    };
  }, [client]);

  const reportError = useCallback((nextError) => {
    setError(getErrorMessage(nextError));
    setCanRetryConnection(false);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setCanRetryConnection(false);
  }, []);

  const retryConnection = useCallback(async () => {
    if (!client || client.isAuthenticating) return;
    setError(null);
    setCanRetryConnection(false);
    setIsReconnecting(true);
    setAuthState("authenticating");
    try {
      client.clearReconnectToken();
      await client.connect();
    } catch (nextError) {
      setAuthState("error");
      setError(getErrorMessage(nextError));
      setCanRetryConnection(true);
      setIsReconnecting(false);
    }
  }, [client]);

  const startConversation = useCallback(
    async (options) => {
      if (!client) throw new Error("Voice client is not available yet.");
      if (!client.isAuthenticated || connectionState !== "connected") {
        throw new Error("The assistant is still connecting. Please try again in a moment.");
      }

      setError(null);
      setIsStartingConversation(true);
      try {
        await client.startConversation(options);
      } catch (nextError) {
        setError(getErrorMessage(nextError));
        throw nextError;
      } finally {
        setIsStartingConversation(false);
      }
    },
    [client, connectionState]
  );

  const endConversation = useCallback(async () => {
    if (!client) return;
    setIsStartingConversation(false);
    try {
      await client.endConversation();
    } catch (nextError) {
      setError(getErrorMessage(nextError));
      throw nextError;
    }
  }, [client]);

  const status = useMemo(
    () =>
      getAIWidgetStatus({
        connectionState,
        agentState,
        callState,
        authState,
        isStartingConversation,
        isReconnecting,
        error,
      }),
    [
      agentState,
      authState,
      callState,
      connectionState,
      error,
      isReconnecting,
      isStartingConversation,
    ]
  );

  const diagnostics = useMemo(
    () =>
      buildAIDiagnostics({
        agentState,
        client,
        connectionInfo,
        connectionState,
        callState,
      }),
    [agentState, callState, client, connectionInfo, connectionState]
  );

  const value = useMemo(
    () => ({
      agentState,
      authState,
      callState,
      canStartConversation:
        Boolean(client?.isAuthenticated) &&
        connectionState === "connected" &&
        !isStartingConversation &&
        !isReconnecting,
      canRetryConnection,
      clearError,
      diagnostics,
      endConversation,
      error,
      hasActiveConversation,
      isReconnecting,
      isStartingConversation,
      reportError,
      retryConnection,
      startConversation,
      status,
    }),
    [
      agentState,
      authState,
      canRetryConnection,
      callState,
      clearError,
      client,
      connectionState,
      diagnostics,
      endConversation,
      error,
      hasActiveConversation,
      isReconnecting,
      isStartingConversation,
      reportError,
      retryConnection,
      startConversation,
      status,
    ]
  );

  return <AIWidgetUIContext.Provider value={value}>{children}</AIWidgetUIContext.Provider>;
}

export function useAIWidgetUI() {
  const context = useContext(AIWidgetUIContext);
  if (!context) {
    throw new Error("useAIWidgetUI must be used within AIWidgetUIProvider");
  }
  return context;
}
