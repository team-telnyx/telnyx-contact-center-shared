"use client";

import { useState, useEffect, useRef } from "react";
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
  IconPhoneCall as IconPhoneForwarded, // Use IconPhoneCall as fallback for IconPhoneForwarded
  IconVolumeOff,
  IconVolume,
  IconSettings,
  IconActivity,
} from "@tabler/icons-react";

export default function CTITestingPage() {
  // Phone configuration state
  const [phoneConfig, setPhoneConfig] = useState({
    ip: "",
    port: "5060",
    username: "",
    password: "",
    macAddress: "",
    model: "Polycom VVX300",
    sipDomain: "",
  });

  // Phone status state
  const [phoneStatus, setPhoneStatus] = useState({
    connected: false,
    state: "idle", // idle, dialing, ringing, connected, hold
    currentCall: null,
  });

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
    addEvent("info", "Testing phone connection", phoneConfig);
    
    try {
      const response = await fetch("/api/voice/cti/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneConfig }),
      });

      const result = await response.json();
      
      if (result.ok) {
        addEvent("success", "Phone connection test successful", result.data);
        setPhoneStatus(prev => ({ ...prev, connected: true }));
      } else {
        addEvent("error", `Connection test failed: ${result.error}`);
        setPhoneStatus(prev => ({ ...prev, connected: false }));
      }
    } catch (error) {
      addEvent("error", `Network error: ${error.message}`);
      setPhoneStatus(prev => ({ ...prev, connected: false }));
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
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">CTI Testing</h1>
          <p className="text-muted-foreground">
            Test Computer Telephony Integration with SIP phones (Polycom VVX300)
          </p>
        </div>
        <Badge variant="outline" className={phoneStatus.connected ? "border-green-500 text-green-700" : "border-red-500 text-red-700"}>
          <IconActivity className="w-4 h-4 mr-2" />
          {phoneStatus.connected ? "Connected" : "Disconnected"}
        </Badge>
      </div>

      <Tabs defaultValue="controls" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="controls">Call Controls</TabsTrigger>
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
                Configure connection parameters for your SIP phone
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
                  <Label htmlFor="port">SIP Port</Label>
                  <Input
                    id="port"
                    placeholder="5060"
                    value={phoneConfig.port}
                    onChange={(e) => setPhoneConfig(prev => ({ ...prev, port: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="username">SIP Username</Label>
                  <Input
                    id="username"
                    placeholder="Extension number"
                    value={phoneConfig.username}
                    onChange={(e) => setPhoneConfig(prev => ({ ...prev, username: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">SIP Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={phoneConfig.password}
                    onChange={(e) => setPhoneConfig(prev => ({ ...prev, password: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mac">MAC Address</Label>
                  <Input
                    id="mac"
                    placeholder="00:04:f2:ab:cd:ef"
                    value={phoneConfig.macAddress}
                    onChange={(e) => setPhoneConfig(prev => ({ ...prev, macAddress: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="domain">SIP Domain</Label>
                  <Input
                    id="domain"
                    placeholder="sip.telnyx.com"
                    value={phoneConfig.sipDomain}
                    onChange={(e) => setPhoneConfig(prev => ({ ...prev, sipDomain: e.target.value }))}
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
                  Basic call operations via SIP NOTIFY
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
                    disabled={!phoneConfig.ip || phoneStatus.state !== "ringing"}
                  >
                    <IconPlayerPlay className="w-4 h-4 mr-2" />
                    Answer
                  </Button>
                  <Button 
                    onClick={handleHangup} 
                    variant="destructive"
                    disabled={!phoneConfig.ip || phoneStatus.state === "idle"}
                  >
                    <IconPhoneOff className="w-4 h-4 mr-2" />
                    Hangup
                  </Button>
                  <Button 
                    onClick={handleHold}
                    variant="outline"
                    disabled={!phoneConfig.ip || !["connected", "hold"].includes(phoneStatus.state)}
                  >
                    <IconPlayerPause className="w-4 h-4 mr-2" />
                    {phoneStatus.state === "hold" ? "Resume" : "Hold"}
                  </Button>
                  <Button 
                    onClick={handleMute}
                    variant="outline"
                    disabled={!phoneConfig.ip || phoneStatus.state === "idle"}
                  >
                    <IconMicrophoneOff className="w-4 h-4 mr-2" />
                    Mute
                  </Button>
                  <Button 
                    onClick={handleTransfer}
                    variant="outline"
                    disabled={!phoneConfig.ip || !["connected", "hold"].includes(phoneStatus.state)}
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
                <CardTitle>Phone Status</CardTitle>
                <CardDescription>
                  Current state and call information
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium">Connection:</span>
                    <Badge variant="outline" className={phoneStatus.connected ? "border-green-500 text-green-700" : "border-red-500 text-red-700"}>
                      {phoneStatus.connected ? "Connected" : "Disconnected"}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium">State:</span>
                    <Badge className={getStateColor(phoneStatus.state)}>
                      {phoneStatus.state.toUpperCase()}
                    </Badge>
                  </div>
                  {phoneStatus.currentCall && (
                    <div className="space-y-2 p-3 bg-gray-50 rounded-lg">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium">Current Call:</span>
                        <span className="text-sm">{phoneStatus.currentCall.number}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium">Duration:</span>
                        <span className="text-sm">
                          {phoneStatus.currentCall.startTime && 
                            Math.floor((Date.now() - new Date(phoneStatus.currentCall.startTime)) / 1000)
                          }s
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
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
                          <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto">
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
  );
}