"use client";

import { useState, useEffect, useRef } from "react";
import { AdminPageContent, AdminPageHeader, AdminPageShell } from "@/components/contact-center/WorkspacePageLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  IconPhone,
  IconPhoneOff,
  IconPlayerPause,
  IconPlayerPlay,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneCall as IconPhoneForwarded,
  IconVolumeOff,
  IconVolume,
  IconSettings,
  IconActivity,
  IconFileText,
  IconRefresh
} from "@tabler/icons-react";

export default function CTITestingPage() {
  // Phone configuration state
  const [phoneConfig, setPhoneConfig] = useState({
    ip: "",
    port: "80", // Default to HTTP for REST
    username: "Polycom", // Default for REST API
    password: "",
    model: "Polycom VVX300"
  });

  // Phone status state
  const [phoneStatus, setPhoneStatus] = useState({
    connected: false,
    state: "idle", // idle, dialing, ringing, connected, hold
    currentCall: null,
    details: null
  });

  // Logs state
  const [phoneLogs, setPhoneLogs] = useState("");
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);

  // Call controls state
  const [dialNumber, setDialNumber] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);

  // Event logging
  const [events, setEvents] = useState([]);
  const eventsEndRef = useRef(null);

  // Add event to log
  const addEvent = (type, message, data = null) => {
    const event = {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      type, // success, error, info, warning
      message,
      data,
    };
    setEvents(prev => [event, ...prev].slice(0, 100)); // Keep last 100 events
  };

  // Auto-scroll to latest event
  useEffect(() => {
    if (eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events]);

  // CTI Actions
  const handleDial = async () => {
    if (!dialNumber.trim()) {
      addEvent("error", "Please enter a number to dial");
      return;
    }

    setIsConnecting(true);
    addEvent("info", `Initiating call to ${dialNumber}`, { number: dialNumber });

    try {
      const response = await fetch("/api/voice/cti/dial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneConfig,
          number: dialNumber,
        }),
      });

      const result = await response.json();
      
      if (result.ok) {
        addEvent("success", `Call initiated to ${dialNumber}`, result.data);
        setPhoneStatus(prev => ({ 
          ...prev, 
          state: "dialing", 
          currentCall: { number: dialNumber, startTime: new Date() }
        }));
      } else {
        addEvent("error", `Failed to dial: ${result.error}`, result);
      }
    } catch (error) {
      addEvent("error", `Network error: ${error.message}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleAnswer = async () => {
    addEvent("info", "Answering incoming call");
    
    try {
      const response = await fetch("/api/voice/cti/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneConfig }),
      });

      const result = await response.json();
      
      if (result.ok) {
        addEvent("success", "Call answered", result.data);
        setPhoneStatus(prev => ({ ...prev, state: "connected" }));
      } else {
        addEvent("error", `Failed to answer: ${result.error}`);
      }
    } catch (error) {
      addEvent("error", `Network error: ${error.message}`);
    }
  };

  const handleHangup = async () => {
    addEvent("info", "Hanging up call");
    
    try {
      const response = await fetch("/api/voice/cti/hangup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneConfig }),
      });

      const result = await response.json();
      
      if (result.ok) {
        addEvent("success", "Call ended", result.data);
        setPhoneStatus(prev => ({ ...prev, state: "idle", currentCall: null }));
      } else {
        addEvent("error", `Failed to hangup: ${result.error}`);
      }
    } catch (error) {
      addEvent("error", `Network error: ${error.message}`);
    }
  };

  const handleHold = async () => {
    const action = phoneStatus.state === "hold" ? "unhold" : "hold";
    addEvent("info", `${action === "hold" ? "Holding" : "Resuming"} call`);
    
    try {
      const response = await fetch(`/api/voice/cti/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneConfig }),
      });

      const result = await response.json();
      
      if (result.ok) {
        addEvent("success", `Call ${action}ed`, result.data);
        setPhoneStatus(prev => ({ 
          ...prev, 
          state: action === "hold" ? "hold" : "connected" 
        }));
      } else {
        addEvent("error", `Failed to ${action}: ${result.error}`);
      }
    } catch (error) {
      addEvent("error", `Network error: ${error.message}`);
    }
  };

  const handleMute = async () => {
    addEvent("info", "Toggling mute");
    
    try {
      const response = await fetch("/api/voice/cti/mute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneConfig }),
      });

      const result = await response.json();
      
      if (result.ok) {
        addEvent("success", "Mute toggled", result.data);
      } else {
        addEvent("error", `Failed to toggle mute: ${result.error}`);
      }
    } catch (error) {
      addEvent("error", `Network error: ${error.message}`);
    }
  };

  const handleTransfer = async () => {
    const transferNumber = prompt("Enter number to transfer to:");
    if (!transferNumber) return;

    addEvent("info", `Transferring call to ${transferNumber}`);
    
    try {
      const response = await fetch("/api/voice/cti/transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneConfig, number: transferNumber }),
      });

      const result = await response.json();
      
      if (result.ok) {
        addEvent("success", `Call transferred to ${transferNumber}`, result.data);
        setPhoneStatus(prev => ({ ...prev, state: "idle", currentCall: null }));
      } else {
        addEvent("error", `Failed to transfer: ${result.error}`);
      }
    } catch (error) {
      addEvent("error", `Network error: ${error.message}`);
    }
  };

  const testConnection = async () => {
    addEvent("info", "Testing phone connection (REST API)", phoneConfig);
    
    try {
      const response = await fetch("/api/voice/cti/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneConfig }),
      });

      const result = await response.json();
      
      if (result.ok) {
        addEvent("success", "Phone connection successful", result.data);
        setPhoneStatus(prev => ({ 
          ...prev, 
          connected: true,
          details: result.data
        }));
      } else {
        addEvent("error", `Connection test failed: ${result.error}`, result);
        setPhoneStatus(prev => ({ ...prev, connected: false }));
      }
    } catch (error) {
      addEvent("error", `Network error: ${error.message}`);
      setPhoneStatus(prev => ({ ...prev, connected: false }));
    }
  };

  const fetchLogs = async () => {
    setIsLoadingLogs(true);
    addEvent("info", "Fetching phone logs...");
    
    try {
      const response = await fetch("/api/voice/cti/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneConfig }),
      });

      const result = await response.json();
      
      if (result.ok) {
        addEvent("success", "Logs fetched successfully");
        setPhoneLogs(JSON.stringify(result.data, null, 2));
      } else {
        addEvent("error", `Failed to fetch logs: ${result.error}`);
      }
    } catch (error) {
      addEvent("error", `Network error: ${error.message}`);
    } finally {
      setIsLoadingLogs(false);
    }
  };

  const clearEvents = () => {
    setEvents([]);
    addEvent("info", "Event log cleared");
  };

  const getEventTypeColor = (type) => {
    switch (type) {
      case "success": return "bg-green-100 text-green-800 border-green-200";
      case "error": return "bg-red-100 text-red-800 border-red-200";
      case "warning": return "bg-yellow-100 text-yellow-800 border-yellow-200";
      case "info": 
      default: return "bg-blue-100 text-blue-800 border-blue-200";
    }
  };

  const getStateColor = (state) => {
    switch (state) {
      case "connected": return "bg-green-100 text-green-800";
      case "dialing": return "bg-yellow-100 text-yellow-800";
      case "ringing": return "bg-blue-100 text-blue-800";
      case "hold": return "bg-orange-100 text-orange-800";
      case "idle": 
      default: return "bg-gray-100 text-gray-800";
    }
  };

  return (
    <AdminPageShell>
      <AdminPageHeader
        title="CTI Testing"
        badges={
          <Badge variant="outline" className={phoneStatus.connected ? "border-green-500 text-green-700" : "border-red-500 text-red-700"}>
            <IconActivity className="w-4 h-4 mr-2" />
            {phoneStatus.connected ? "Connected" : "Disconnected"}
          </Badge>
        }
      />
      <AdminPageContent>
        <div className="space-y-6">
      <Tabs defaultValue="controls" className="w-full">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="controls">Call Controls</TabsTrigger>
          <TabsTrigger value="logs">Phone Logs</TabsTrigger>
          <TabsTrigger value="config">Phone Configuration</TabsTrigger>
          <TabsTrigger value="events">Event Log</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <IconSettings className="w-5 h-5 mr-2" />
                Phone Configuration
              </CardTitle>
              <CardDescription>
                Configure connection parameters for your SIP phone (REST API)
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ip">Phone IP Address</Label>
                  <Input
                    id="ip"
                    placeholder="192.168.1.100"
                    value={phoneConfig.ip}
                    onChange={(e) => setPhoneConfig(prev => ({ ...prev, ip: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="port">Port (80/443)</Label>
                  <Input
                    id="port"
                    placeholder="80"
                    value={phoneConfig.port}
                    onChange={(e) => setPhoneConfig(prev => ({ ...prev, port: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="username">Username (usually Polycom)</Label>
                  <Input
                    id="username"
                    placeholder="Polycom"
                    value={phoneConfig.username}
                    onChange={(e) => setPhoneConfig(prev => ({ ...prev, username: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={phoneConfig.password}
                    onChange={(e) => setPhoneConfig(prev => ({ ...prev, password: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={testConnection} variant="outline">
                  Test Connection
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="controls" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Call Controls */}
            <Card>
              <CardHeader>
                <CardTitle>Call Controls</CardTitle>
                <CardDescription>
                  Basic call operations via REST API
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="dialNumber">Phone Number</Label>
                  <div className="flex gap-2">
                    <Input
                      id="dialNumber"
                      placeholder="+1234567890"
                      value={dialNumber}
                      onChange={(e) => setDialNumber(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleDial()}
                    />
                    <Button 
                      onClick={handleDial} 
                      disabled={!phoneConfig.ip || isConnecting}
                    >
                      <IconPhone className="w-4 h-4 mr-2" />
                      {isConnecting ? "Dialing..." : "Dial"}
                    </Button>
                  </div>
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-2">
                  <Button 
                    onClick={handleAnswer} 
                    variant="outline"
                    disabled={!phoneConfig.ip}
                  >
                    <IconPlayerPlay className="w-4 h-4 mr-2" />
                    Answer
                  </Button>
                  <Button 
                    onClick={handleHangup} 
                    variant="destructive"
                    disabled={!phoneConfig.ip}
                  >
                    <IconPhoneOff className="w-4 h-4 mr-2" />
                    Hangup
                  </Button>
                  <Button 
                    onClick={handleHold}
                    variant="outline"
                    disabled={!phoneConfig.ip}
                  >
                    <IconPlayerPause className="w-4 h-4 mr-2" />
                    Hold/Resume
                  </Button>
                  <Button 
                    onClick={handleMute}
                    variant="outline"
                    disabled={!phoneConfig.ip}
                  >
                    <IconMicrophoneOff className="w-4 h-4 mr-2" />
                    Mute
                  </Button>
                  <Button 
                    onClick={handleTransfer}
                    variant="outline"
                    disabled={!phoneConfig.ip}
                    className="col-span-2"
                  >
                    <IconPhoneForwarded className="w-4 h-4 mr-2" />
                    Transfer
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Phone Status */}
            <Card>
              <CardHeader>
                <CardTitle>Phone Info</CardTitle>
                <CardDescription>
                  Details from Device Info API
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {phoneStatus.details ? (
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="font-medium">Model:</span>
                      <span>{phoneStatus.details.ModelNumber}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-medium">Firmware:</span>
                      <span>{phoneStatus.details.Firmware?.Application}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-medium">MAC:</span>
                      <span>{phoneStatus.details.MACAddress}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-medium">IP:</span>
                      <span>{phoneStatus.details.IPAddress}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="font-medium">State:</span>
                      <Badge variant="outline">{phoneStatus.details.AppState}</Badge>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">Connect to phone to see details.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="logs" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex justify-between items-center">
                Device Logs
                <Button variant="outline" size="sm" onClick={fetchLogs} disabled={isLoadingLogs}>
                  <IconRefresh className={`w-4 h-4 mr-2 ${isLoadingLogs ? 'animate-spin' : ''}`} />
                  Refresh Logs
                </Button>
              </CardTitle>
              <CardDescription>
                Fetch internal logs from the device
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px] w-full border rounded-lg p-4 bg-black text-white font-mono text-xs">
                {phoneLogs || "No logs fetched yet."}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="events" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex justify-between items-center">
                Event Log
                <Button variant="outline" size="sm" onClick={clearEvents}>
                  Clear Log
                </Button>
              </CardTitle>
              <CardDescription>
                Real-time logging of CTI events and responses
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px] w-full border rounded-lg p-4">
                {events.length === 0 ? (
                  <p className="text-muted-foreground text-center py-8">
                    No events yet. Try performing some actions.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {events.map((event) => (
                      <div key={event.id} className="border rounded-lg p-3 space-y-2">
                        <div className="flex justify-between items-start">
                          <div className="flex items-center gap-2">
                            <Badge className={getEventTypeColor(event.type)}>
                              {event.type.toUpperCase()}
                            </Badge>
                            <span className="text-sm font-medium">{event.message}</span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {new Date(event.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        {event.data && (
                          <pre className="text-xs bg-slate-900 text-slate-50 p-2 rounded overflow-auto border border-slate-700">
                            {JSON.stringify(event.data, null, 2)}
                          </pre>
                        )}
                      </div>
                    ))}
                    <div ref={eventsEndRef} />
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
        </div>
      </AdminPageContent>
    </AdminPageShell>
  );
}
