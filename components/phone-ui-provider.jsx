"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useEffect,
} from "react";
import useDialStore from "@/lib/stores/dial-store";

const PhoneUiContext = createContext({
  visible: false,
  toggle: () => {},
});

export function usePhoneUi() {
  return useContext(PhoneUiContext);
}

export function PhoneUiProvider({ children }) {
  const [visible, setVisible] = useState(false);
  const toggle = useCallback(() => setVisible((v) => !v), []);

  // Listen for custom events to open softphone
  useEffect(() => {
    const handleSoftphoneOpen = (event) => {
      console.log("Softphone open event received:", event.detail);
      setVisible(true);
      // If there's a toNumber in the event detail, set it in the dial store
      if (event.detail?.toNumber) {
        try {
          console.log("Setting toNumber to:", event.detail.toNumber);
          const { setToNumber } = useDialStore.getState();
          setToNumber(event.detail.toNumber);
        } catch (error) {
          console.error("Failed to set toNumber:", error);
        }
      }
    };

    window.addEventListener("softphone:open", handleSoftphoneOpen);
    return () =>
      window.removeEventListener("softphone:open", handleSoftphoneOpen);
  }, []);

  const value = useMemo(() => ({ visible, toggle }), [visible, toggle]);
  return (
    <PhoneUiContext.Provider value={value}>{children}</PhoneUiContext.Provider>
  );
}
