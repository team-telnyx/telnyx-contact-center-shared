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
  const [mediaFiles, setMediaFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audio, setAudio] = useState(null);
  const [selectedMediaName, setSelectedMediaName] = useState(null);

  // Load media files from Media Library API
  useEffect(() => {
    async function loadMediaFiles() {
      if (audioSource !== "media_library") return;

      try {
        setLoading(true);
        const response = await fetch("/api/admin/media-library?pageSize=100");
        if (response.ok) {
          const data = await response.json();
          setMediaFiles(data.items || []);
        } else {
          console.error("Error loading media files:", response.statusText);
        }
      } catch (error) {
        console.error("Error loading media files:", error);
      } finally {
        setLoading(false);
      }
    }
    loadMediaFiles();
  }, [audioSource]);

  // Determine initial audio source based on current audio_url
  useEffect(() => {
    if (config.audio_url) {
      // Check if it's a media_name format (used by Telnyx Media API)
      // Media names are typically UUIDs or custom names without http:// or https://
      const isMediaName = !config.audio_url.startsWith("http://") && 
                          !config.audio_url.startsWith("https://") &&
                          config.audio_url.trim().length > 0;
      
      if (isMediaName) {
        setAudioSource("media_library");
        setSelectedMediaName(config.audio_url);
      } else {
        setAudioSource("custom_url");
      }
    }
  }, [config.audio_url]);

  const handleSourceTypeChange = (newSource) => {
    setAudioSource(newSource);
    if (newSource === "media_library") {
      // Clear the custom URL when switching to media library
      onChange?.({ ...config, audio_url: "" });
      setSelectedMediaName(null);
    } else {
      setSelectedMediaName(null);
    }
  };

  const handleMediaFileSelect = (mediaName) => {
    setSelectedMediaName(mediaName);
    // For Telnyx Media API, we use the media_name directly (not a URL)
    // The Telnyx API will resolve it to the actual media file
    onChange?.({ ...config, audio_url: mediaName });
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
      
      // If it's a media library file, use the stream endpoint
      let playUrl = audioUrl;
      if (audioSource === "media_library" && selectedMediaName) {
        playUrl = `/api/admin/media-library/${encodeURIComponent(selectedMediaName)}/stream`;
      }

      const audioElement = new Audio(playUrl);

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

  const handlePlayMediaFile = async (mediaName) => {
    // Stop current playback if playing
    if (isPlaying && audio) {
      audio.pause();
      audio.currentTime = 0;
      setIsPlaying(false);
      setAudio(null);
    }

    // If clicking the same file that's already selected, toggle play/stop
    if (selectedMediaName === mediaName && !isPlaying) {
      // Select the file first if not selected
      handleMediaFileSelect(mediaName);
      // Wait a bit then play
      setTimeout(() => {
        handleTestAudio();
      }, 100);
      return;
    }

    // Select the file and play
    handleMediaFileSelect(mediaName);
    setTimeout(() => {
      handleTestAudio();
    }, 100);
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
          <div className="flex items-center gap-2 mt-1">
            <Select
              value={selectedMediaName || ""}
              onValueChange={handleMediaFileSelect}
              disabled={loading}
              className="flex-1"
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={
                    loading
                      ? "Loading audio files..."
                      : mediaFiles.length === 0
                      ? "No audio files available"
                      : "Select from media library"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {mediaFiles.length === 0 && !loading ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    No audio files found. Upload files in Admin → Media Library.
                  </div>
                ) : (
                  mediaFiles.map((file) => (
                    <SelectItem key={file.media_name} value={file.media_name}>
                      {file.media_name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-10 w-10 shrink-0"
              onClick={() => {
                if (selectedMediaName) {
                  handlePlayMediaFile(selectedMediaName);
                } else {
                  notify({
                    title: "No file selected",
                    description: "Please select an audio file first",
                    variant: "error",
                  });
                }
              }}
              disabled={!selectedMediaName || loading}
            >
              {isPlaying && selectedMediaName === config.audio_url ? (
                <IconPlayerStop className="h-4 w-4" />
              ) : (
                <IconPlayerPlay className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Audio URL Input */}
      <div>
        <Label htmlFor="audio_url">
          {audioSource === "media_library" ? "Media Name" : "Audio URL"}{" "}
          <span className="text-red-500">*</span>
        </Label>
        <Input
          id="audio_url"
          type="text"
          value={config.audio_url || ""}
          onChange={(e) => handleCustomUrlChange(e.target.value)}
          placeholder={
            audioSource === "media_library"
              ? "Media name (e.g., welcome-message)"
              : "https://example.com/audio.mp3"
          }
          disabled={audioSource === "media_library"}
          className="mt-1 font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground mt-1">
          {audioSource === "media_library"
            ? "Media name from Telnyx Media Library (used in Telnyx API calls)"
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
