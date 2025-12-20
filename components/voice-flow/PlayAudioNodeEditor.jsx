"use client";

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ToastNotify";

export default function PlayAudioNodeEditor({ config = {}, onChange }) {
  const [audioSource, setAudioSource] = useState("custom_url");
  const [audioFiles, setAudioFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audio, setAudio] = useState(null);

  // Load audio files from media library
  useEffect(() => {
    async function loadAudioFiles() {
      try {
        setLoading(true);
        const response = await fetch("/api/media/audio");
        if (response.ok) {
          const data = await response.json();
          setAudioFiles(data.files || []);
        }
      } catch (error) {
        console.error("Error loading audio files:", error);
      } finally {
        setLoading(false);
      }
    }
    loadAudioFiles();
  }, []);

  // Determine initial audio source based on current audio_url
  useEffect(() => {
    if (config.audio_url) {
      const isFromMediaLibrary = audioFiles.some(
        (file) => file.url === config.audio_url
      );
      setAudioSource(isFromMediaLibrary ? "media_library" : "custom_url");
    }
  }, [config.audio_url, audioFiles]);

  const handleSourceTypeChange = (newSource) => {
    setAudioSource(newSource);
    if (newSource === "media_library") {
      // Clear the custom URL when switching to media library
      onChange?.({ ...config, audio_url: "" });
    }
  };

  const handleMediaFileSelect = (fileUrl) => {
    onChange?.({ ...config, audio_url: fileUrl });
  };

  const handleCustomUrlChange = (url) => {
    onChange?.({ ...config, audio_url: url });
  };

  const handleTestAudio = async () => {
    if (isPlaying && audio) {
      audio.pause();
      audio.currentTime = 0;
      setIsPlaying(false);
      setAudio(null);
      return;
    }

    const audioUrl = config.audio_url;

    if (!audioUrl || !audioUrl.trim()) {
      notify({
        title: "Error",
        description: "Please enter or select an audio URL",
        variant: "error",
      });
      return;
    }

    try {
      setIsPlaying(true);
      const audioElement = new Audio(audioUrl);

      audioElement.onended = () => {
        setIsPlaying(false);
        setAudio(null);
      };

      audioElement.onerror = () => {
        setIsPlaying(false);
        setAudio(null);
        notify({
          title: "Error",
          description: "Error loading audio file. Check the URL is accessible.",
          variant: "error",
        });
      };

      setAudio(audioElement);
      await audioElement.play();
    } catch (error) {
      console.error("Error testing audio:", error);
      notify({
        title: "Error",
        description: error.message || "Failed to play audio",
        variant: "error",
      });
      setIsPlaying(false);
      setAudio(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Audio Source Type */}
      <div>
        <Label>
          Audio Source <span className="text-red-500">*</span>
        </Label>
        <Select value={audioSource} onValueChange={handleSourceTypeChange}>
          <SelectTrigger className="w-full mt-1">
            <SelectValue placeholder="Select audio source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="custom_url">Custom URL</SelectItem>
            <SelectItem value="media_library">Media Library</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Media Library Selector */}
      {audioSource === "media_library" && (
        <div>
          <Label>Select Audio File</Label>
          <Select
            value={config.audio_url || ""}
            onValueChange={handleMediaFileSelect}
            disabled={loading}
          >
            <SelectTrigger className="w-full mt-1">
              <SelectValue
                placeholder={
                  loading
                    ? "Loading audio files..."
                    : audioFiles.length === 0
                    ? "No audio files available"
                    : "Select from media library"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {audioFiles.length === 0 && !loading ? (
                <div className="p-2 text-sm text-muted-foreground">
                  No audio files found. Upload files in Storage → Media.
                </div>
              ) : (
                audioFiles.map((file) => (
                  <SelectItem key={file.url} value={file.url}>
                    {file.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Audio URL Input */}
      <div>
        <Label htmlFor="audio_url">
          Audio URL <span className="text-red-500">*</span>
        </Label>
        <Input
          id="audio_url"
          type="text"
          value={config.audio_url || ""}
          onChange={(e) => handleCustomUrlChange(e.target.value)}
          placeholder="https://example.com/audio.mp3"
          disabled={audioSource === "media_library"}
          className="mt-1 font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground mt-1">
          {audioSource === "media_library"
            ? "URL is set from the selected media file"
            : "The URL of the audio file to play (WAV or MP3)"}
        </p>
      </div>

      {/* Test Audio Button */}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleTestAudio}
          disabled={!config.audio_url?.trim()}
          className="w-full"
        >
          {isPlaying ? (
            <>
              <IconPlayerStop className="w-4 h-4 mr-2" />
              Stop Audio
            </>
          ) : (
            <>
              <IconPlayerPlay className="w-4 h-4 mr-2" />
              Test Audio
            </>
          )}
        </Button>
      </div>

      {/* Loop Configuration */}
      <div>
        <Label htmlFor="loop">Loop</Label>
        <Select
          value={config.loop || "1"}
          onValueChange={(value) => onChange?.({ ...config, loop: value })}
        >
          <SelectTrigger className="w-full mt-1">
            <SelectValue placeholder="Select loop option" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1">1 time</SelectItem>
            <SelectItem value="2">2 times</SelectItem>
            <SelectItem value="3">3 times</SelectItem>
            <SelectItem value="4">4 times</SelectItem>
            <SelectItem value="5">5 times</SelectItem>
            <SelectItem value="6">6 times</SelectItem>
            <SelectItem value="7">7 times</SelectItem>
            <SelectItem value="8">8 times</SelectItem>
            <SelectItem value="9">9 times</SelectItem>
            <SelectItem value="10">10 times</SelectItem>
            <SelectItem value="infinity">Loop infinitely</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          How many times the audio file should be played (1-10 or infinity)
        </p>
      </div>

      {/* Overlay Configuration */}
      <div className="flex items-center space-x-2">
        <Checkbox
          id="overlay"
          checked={config.overlay || false}
          onCheckedChange={(checked) =>
            onChange?.({ ...config, overlay: checked })
          }
        />
        <Label htmlFor="overlay" className="text-sm font-normal cursor-pointer">
          Overlay audio over currently playing audio
        </Label>
      </div>

      {/* Target Legs Configuration */}
      <div>
        <Label htmlFor="target_legs">Target Legs</Label>
        <Select
          value={config.target_legs || "self"}
          onValueChange={(value) =>
            onChange?.({ ...config, target_legs: value })
          }
        >
          <SelectTrigger className="w-full mt-1">
            <SelectValue placeholder="Select target legs" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="self">Self</SelectItem>
            <SelectItem value="opposite">Opposite</SelectItem>
            <SelectItem value="both">Both</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground mt-1">
          Specifies which leg(s) of the call will hear the audio
        </p>
      </div>
    </div>
  );
}
