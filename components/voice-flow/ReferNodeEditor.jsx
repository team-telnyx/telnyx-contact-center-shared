"use client";

import { useState, useEffect, useRef } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconTrash, IconPlus } from "@tabler/icons-react";

export default function ReferNodeEditor({ config = {}, onChange }) {
  const [sipAddress, setSipAddress] = useState(config.sip_address || "");
  const [clientState, setClientState] = useState(config.client_state || "");
  const [commandId, setCommandId] = useState(config.command_id || "");
  const [sipAuthUsername, setSipAuthUsername] = useState(
    config.sip_auth_username || ""
  );
  const [sipAuthPassword, setSipAuthPassword] = useState(
    config.sip_auth_password || ""
  );
  const [customHeaders, setCustomHeaders] = useState(
    Array.isArray(config.custom_headers) ? config.custom_headers : []
  );
  const [sipHeaders, setSipHeaders] = useState(
    Array.isArray(config.sip_headers) ? config.sip_headers : []
  );
  const lastConfigRef = useRef(JSON.stringify(config));
  const sipHeadersRef = useRef(sipHeaders);
  const customHeadersRef = useRef(customHeaders);
  
  // Keep refs in sync with state
  useEffect(() => {
    sipHeadersRef.current = sipHeaders;
  }, [sipHeaders]);
  
  useEffect(() => {
    customHeadersRef.current = customHeaders;
  }, [customHeaders]);

  const SIP_HEADER_NAMES = ["User-to-User", "Diversion"];

  // Sync state from config changes (only on mount or when config changes externally)
  useEffect(() => {
    const currentConfigStr = JSON.stringify(config);
    const lastConfig = JSON.parse(lastConfigRef.current || "{}");
    
    if (config.sip_address !== undefined && config.sip_address !== sipAddress) {
      setSipAddress(config.sip_address);
    }
    if (config.client_state !== undefined && config.client_state !== clientState) {
      setClientState(config.client_state);
    }
    if (config.command_id !== undefined && config.command_id !== commandId) {
      setCommandId(config.command_id);
    }
    if (
      config.sip_auth_username !== undefined &&
      config.sip_auth_username !== sipAuthUsername
    ) {
      setSipAuthUsername(config.sip_auth_username);
    }
    if (
      config.sip_auth_password !== undefined &&
      config.sip_auth_password !== sipAuthPassword
    ) {
      setSipAuthPassword(config.sip_auth_password);
    }
    // Only update custom_headers if the config actually changed externally
    // Compare with the last config we processed to avoid resetting during editing
    const configCustomHeaders = Array.isArray(config.custom_headers)
      ? config.custom_headers
      : [];
    const lastConfigCustomHeaders = Array.isArray(lastConfig.custom_headers)
      ? lastConfig.custom_headers
      : [];
    
    // Only update if:
    // 1. Config actually changed (not just a re-render from our own onChange)
    // 2. The custom_headers in config are different from what we last processed
    // 3. We don't have local headers that would be lost
    if (
      currentConfigStr !== lastConfigRef.current &&
      config.custom_headers !== undefined
    ) {
      const configCustomHeadersStr = JSON.stringify(configCustomHeaders);
      const lastCustomHeadersStr = JSON.stringify(lastConfigCustomHeaders);
      
      // Only sync if config headers changed AND we won't lose local state
      const currentCustomHeaders = customHeadersRef.current;
      if (
        configCustomHeadersStr !== lastCustomHeadersStr &&
        (currentCustomHeaders.length === 0 || configCustomHeaders.length >= currentCustomHeaders.length)
      ) {
        setCustomHeaders(configCustomHeaders);
      }
    }
    // Only update sip_headers if the config actually changed externally
    // Compare with the last config we processed to avoid resetting during editing
    const configSipHeaders = Array.isArray(config.sip_headers)
      ? config.sip_headers
      : [];
    const lastConfigSipHeaders = Array.isArray(lastConfig.sip_headers)
      ? lastConfig.sip_headers
      : [];
    
    // Only update if:
    // 1. Config actually changed (not just a re-render from our own onChange)
    // 2. The sip_headers in config are different from what we last processed
    // 3. We don't have local headers that would be lost
    if (
      currentConfigStr !== lastConfigRef.current &&
      config.sip_headers !== undefined
    ) {
      const configSipHeadersStr = JSON.stringify(configSipHeaders);
      const lastSipHeadersStr = JSON.stringify(lastConfigSipHeaders);
      
      // Only sync if config headers changed AND we won't lose local state
      const currentSipHeaders = sipHeadersRef.current;
      if (
        configSipHeadersStr !== lastSipHeadersStr &&
        (currentSipHeaders.length === 0 || configSipHeaders.length >= currentSipHeaders.length)
      ) {
        setSipHeaders(configSipHeaders);
      }
    }
    
    // Update the ref to track what we've processed (only once at the end)
    if (currentConfigStr !== lastConfigRef.current) {
      lastConfigRef.current = currentConfigStr;
    }
  }, [config]);

  const updateConfig = (updates) => {
    const newConfig = {
      ...config,
      sip_address: sipAddress,
      client_state: clientState || undefined,
      command_id: commandId || undefined,
      sip_auth_username: sipAuthUsername || undefined,
      sip_auth_password: sipAuthPassword || undefined,
      custom_headers:
        customHeaders.length > 0
          ? customHeaders.filter((h) => h.name || h.value)
          : undefined,
      // Keep all sip_headers in config (don't filter incomplete ones)
      // The engine will filter them when sending to API
      sip_headers: sipHeaders.length > 0 ? sipHeaders : undefined,
      ...updates,
    };
    onChange?.(newConfig);
  };

  const handleSipAddressChange = (value) => {
    setSipAddress(value);
    updateConfig({ sip_address: value });
  };

  const handleClientStateChange = (value) => {
    setClientState(value);
    updateConfig({ client_state: value || undefined });
  };

  const handleCommandIdChange = (value) => {
    setCommandId(value);
    updateConfig({ command_id: value || undefined });
  };

  const handleSipAuthUsernameChange = (value) => {
    setSipAuthUsername(value);
    updateConfig({ sip_auth_username: value || undefined });
  };

  const handleSipAuthPasswordChange = (value) => {
    setSipAuthPassword(value);
    updateConfig({ sip_auth_password: value || undefined });
  };

  const handleCustomHeaderChange = (index, field, value) => {
    const newHeaders = customHeaders.map((h, i) =>
      i === index ? { ...h, [field]: value } : h
    );
    setCustomHeaders(newHeaders);
    updateConfig({
      custom_headers:
        newHeaders.length > 0
          ? newHeaders.filter((h) => h.name || h.value)
          : undefined,
    });
  };

  const addCustomHeader = () => {
    const newHeaders = [...customHeaders, { name: "", value: "" }];
    setCustomHeaders(newHeaders);
    updateConfig({ custom_headers: newHeaders });
  };

  const removeCustomHeader = (index) => {
    const newHeaders = customHeaders.filter((_, i) => i !== index);
    setCustomHeaders(newHeaders);
    updateConfig({
      custom_headers:
        newHeaders.length > 0
          ? newHeaders.filter((h) => h.name || h.value)
          : undefined,
    });
  };

  const handleSipHeaderChange = (index, field, value) => {
    if (field === "name") {
      // Check if this header type is already used by another header
      const isAlreadyUsed = sipHeaders.some(
        (h, i) => i !== index && h.name === value
      );
      if (isAlreadyUsed) {
        // Don't allow changing to a header type that's already in use
        return;
      }
    }
    const newHeaders = sipHeaders.map((h, i) =>
      i === index ? { ...h, [field]: value } : h
    );
    setSipHeaders(newHeaders);
    // Update config with new headers directly, not filtering out incomplete ones
    const newConfig = {
      ...config,
      sip_address: sipAddress,
      client_state: clientState || undefined,
      command_id: commandId || undefined,
      sip_auth_username: sipAuthUsername || undefined,
      sip_auth_password: sipAuthPassword || undefined,
      custom_headers:
        customHeaders.length > 0
          ? customHeaders.filter((h) => h.name || h.value)
          : undefined,
      sip_headers: newHeaders.length > 0 ? newHeaders : undefined,
    };
    onChange?.(newConfig);
  };

  const addSipHeader = () => {
    // Check which header types are already present
    const existingNames = sipHeaders.map((h) => h.name);
    const hasUserToUser = existingNames.includes("User-to-User");
    const hasDiversion = existingNames.includes("Diversion");

    // Don't add if both types are already present
    if (hasUserToUser && hasDiversion) {
      return;
    }

    // Add the missing type, or default to User-to-User if neither exists
    const newHeaderName = hasUserToUser ? "Diversion" : "User-to-User";
    const newHeaders = [...sipHeaders, { name: newHeaderName, value: "" }];
    setSipHeaders(newHeaders);
    const newConfig = {
      ...config,
      sip_address: sipAddress,
      client_state: clientState || undefined,
      command_id: commandId || undefined,
      sip_auth_username: sipAuthUsername || undefined,
      sip_auth_password: sipAuthPassword || undefined,
      custom_headers:
        customHeaders.length > 0
          ? customHeaders.filter((h) => h.name || h.value)
          : undefined,
      sip_headers: newHeaders,
    };
    onChange?.(newConfig);
  };

  // Get available header types (not already in use)
  const getAvailableHeaderTypes = (currentIndex) => {
    const existingNames = sipHeaders
      .map((h, i) => (i !== currentIndex ? h.name : null))
      .filter(Boolean);
    return SIP_HEADER_NAMES.filter((name) => !existingNames.includes(name));
  };

  const removeSipHeader = (index) => {
    const newHeaders = sipHeaders.filter((_, i) => i !== index);
    setSipHeaders(newHeaders);
    const newConfig = {
      ...config,
      sip_address: sipAddress,
      client_state: clientState || undefined,
      command_id: commandId || undefined,
      sip_auth_username: sipAuthUsername || undefined,
      sip_auth_password: sipAuthPassword || undefined,
      custom_headers:
        customHeaders.length > 0
          ? customHeaders.filter((h) => h.name || h.value)
          : undefined,
      sip_headers: newHeaders.length > 0 ? newHeaders : undefined,
    };
    onChange?.(newConfig);
  };

  return (
    <div className="space-y-4">
      {/* SIP Address */}
      <div>
        <Label>
          SIP Address <span className="text-red-500">*</span>
        </Label>
        <Input
          type="text"
          value={sipAddress}
          onChange={(e) => handleSipAddressChange(e.target.value)}
          placeholder="sip:username@sip.non-telnyx-address.com"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          The SIP URI to which the call will be referred to
        </p>
      </div>

      {/* Client State */}
      <div>
        <Label>Client State</Label>
        <Input
          type="text"
          value={clientState}
          onChange={(e) => handleClientStateChange(e.target.value)}
          placeholder="aGF2ZSBhIG5pY2UgZGF5ID1d"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Base-64 encoded string to add state to every subsequent webhook
        </p>
      </div>

      {/* Command ID */}
      <div>
        <Label>Command ID</Label>
        <Input
          type="text"
          value={commandId}
          onChange={(e) => handleCommandIdChange(e.target.value)}
          placeholder="891510ac-f3e4-11e8-af5b-de00688a4901"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          Use this field to avoid execution of duplicate commands
        </p>
      </div>

      {/* SIP Auth Username */}
      <div>
        <Label>SIP Auth Username</Label>
        <Input
          type="text"
          value={sipAuthUsername}
          onChange={(e) => handleSipAuthUsernameChange(e.target.value)}
          placeholder="username"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          SIP Authentication username used for SIP challenges
        </p>
      </div>

      {/* SIP Auth Password */}
      <div>
        <Label>SIP Auth Password</Label>
        <Input
          type="password"
          value={sipAuthPassword}
          onChange={(e) => handleSipAuthPasswordChange(e.target.value)}
          placeholder="password"
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">
          SIP Authentication password used for SIP challenges
        </p>
      </div>

      {/* SIP Headers */}
      <div>
        <Label>SIP Headers</Label>
        <div className="space-y-2 mt-1">
          {sipHeaders.map((header, index) => (
            <div
              key={`sip-header-${index}`}
              className="flex gap-2 items-center"
            >
              <div className="flex-shrink-0 w-32">
                <Select
                  value={header?.name || "User-to-User"}
                  onValueChange={(value) =>
                    handleSipHeaderChange(index, "name", value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select header name" />
                  </SelectTrigger>
                  <SelectContent>
                    {SIP_HEADER_NAMES.map((name) => {
                      const availableTypes = getAvailableHeaderTypes(index);
                      const isAvailable = availableTypes.includes(name);
                      return (
                        <SelectItem
                          key={name}
                          value={name}
                          disabled={!isAvailable}
                        >
                          {name}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
              <Input
                className="flex-1 min-w-0 max-w-[calc(100%-12rem)]"
                placeholder="Header value"
                value={header?.value || ""}
                onChange={(e) =>
                  handleSipHeaderChange(index, "value", e.target.value)
                }
              />
              <div className="flex-shrink-0 w-10">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => removeSipHeader(index)}
                  aria-label="Remove header"
                >
                  <IconTrash className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addSipHeader}
            disabled={
              sipHeaders.length >= 2 ||
              (sipHeaders.some((h) => h.name === "User-to-User") &&
                sipHeaders.some((h) => h.name === "Diversion"))
            }
            className="w-full"
          >
            <IconPlus className="w-4 h-4 mr-2" />
            Add SIP Header
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          SIP headers to be added to the request. Currently only User-to-User
          and Diversion headers are supported.
        </p>
      </div>

      {/* Custom Headers */}
      <div>
        <Label>Custom Headers</Label>
        <div className="space-y-2 mt-1">
          {customHeaders.map((header, index) => (
            <div
              key={`custom-header-${index}`}
              className="flex gap-2 items-center"
            >
              <Input
                className="flex-shrink-0 w-32"
                placeholder="Header name"
                value={header?.name || ""}
                onChange={(e) =>
                  handleCustomHeaderChange(index, "name", e.target.value)
                }
              />
              <Input
                className="flex-1 min-w-0 max-w-[calc(100%-12rem)]"
                placeholder="Header value"
                value={header?.value || ""}
                onChange={(e) =>
                  handleCustomHeaderChange(index, "value", e.target.value)
                }
              />
              <div className="flex-shrink-0 w-10">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => removeCustomHeader(index)}
                  aria-label="Remove header"
                >
                  <IconTrash className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addCustomHeader}
            className="w-full"
          >
            <IconPlus className="w-4 h-4 mr-2" />
            Add Custom Header
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Custom headers to be added to the SIP INVITE
        </p>
      </div>
    </div>
  );
}

