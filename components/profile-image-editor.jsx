"use client";

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  useEffect,
} from "react";
import Cropper from "react-easy-crop";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

function getCroppedImg(imageSrc, cropAreaPixels) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      // Resize to max 400x400 for profile pictures
      const maxSize = 400;
      const scale = Math.min(
        maxSize / cropAreaPixels.width,
        maxSize / cropAreaPixels.height,
        1
      );
      const outputWidth = Math.round(cropAreaPixels.width * scale);
      const outputHeight = Math.round(cropAreaPixels.height * scale);

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = outputWidth;
      canvas.height = outputHeight;

      // Enable image smoothing for better quality when resizing
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      ctx.drawImage(
        image,
        cropAreaPixels.x,
        cropAreaPixels.y,
        cropAreaPixels.width,
        cropAreaPixels.height,
        0,
        0,
        outputWidth,
        outputHeight
      );

      // Convert to JPEG with quality compression (0.85 = 85% quality)
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Canvas is empty"));
          resolve(blob);
        },
        "image/jpeg",
        0.85
      );
    };
    image.onerror = reject;
    image.src = imageSrc;
  });
}

const ProfileImageEditor = forwardRef(function ProfileImageEditor(
  { initialSrc, onPreviewChange },
  ref
) {
  const [imageSrc, setImageSrc] = useState(initialSrc || "");
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef(null);
  const pendingBlobRef = useRef(null);
  const prevSrcRef = useRef(imageSrc);
  const [open, setOpen] = useState(false);

  // Sync image preview with incoming initialSrc when not editing
  useEffect(() => {
    if (!isEditing && initialSrc && initialSrc !== imageSrc) {
      setImageSrc(initialSrc);
      prevSrcRef.current = initialSrc;
    }
  }, [initialSrc]);

  const onCropComplete = useCallback((_, croppedPixels) => {
    setCroppedAreaPixels(croppedPixels);
  }, []);

  useImperativeHandle(ref, () => ({
    async getPendingCroppedBlob() {
      console.log(
        "[ProfileEditor] getPendingCroppedBlob called, blob:",
        pendingBlobRef.current
      );
      return pendingBlobRef.current || null;
    },
    hasImage() {
      return Boolean(imageSrc);
    },
    cancelEditing() {
      setIsEditing(false);
      pendingBlobRef.current = null;
    },
  }));

  async function onFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result.toString();
      prevSrcRef.current = imageSrc;
      setImageSrc(src);
      setIsEditing(true);
      // don't update external preview until user clicks Update
      setOpen(true);
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-col items-start gap-3">
        <div
          className="h-40 w-40 md:h-48 md:w-48 mr-5 rounded-full overflow-hidden bg-muted cursor-pointer"
          onClick={() => {
            prevSrcRef.current = imageSrc;
            setIsEditing(Boolean(imageSrc));
            setOpen(true);
          }}
        >
          {imageSrc ? (
            <img
              src={imageSrc}
              alt="Avatar"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-xs text-muted-foreground">
              No image
            </div>
          )}
        </div>
        {/* Upload control moved to modal */}
      </div>

      <Sheet
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setIsEditing(false);
        }}
      >
        <SheetContent
          side="center"
          className="h-auto max-h-[53vh] w-[90vw] sm:w-1/2 mx-auto inset-0 rounded-xl bg-accent dark:bg-neutral-900"
        >
          <SheetHeader>
            <SheetTitle>Edit profile picture</SheetTitle>
          </SheetHeader>
          {isEditing && imageSrc && (
            <div className="mt-2 flex flex-col gap-3">
              <div className="relative h-[38vh] rounded-md overflow-hidden border">
                <Cropper
                  image={imageSrc}
                  crop={crop}
                  zoom={zoom}
                  aspect={1}
                  onCropChange={setCrop}
                  onZoomChange={setZoom}
                  onCropComplete={onCropComplete}
                  cropShape="round"
                  showGrid={false}
                />
              </div>
              <div className="flex items-center mt-3 gap-3">
                <div className="ml-10 flex items-center justify-end mr-10">
                  <input
                    ref={inputRef}
                    type="file"
                    accept="image/*"
                    onChange={onFileChange}
                    className="hidden"
                  />
                  <Button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                  >
                    Upload
                  </Button>
                </div>
                <label className="text-sm w-10 ml-[20px]">Zoom</label>
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.01}
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                  className="w-48 sm:w-64"
                />
                <div className="ml-auto flex gap-2 mr-10">
                  <Button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setIsEditing(false);
                      setImageSrc(prevSrcRef.current);
                      pendingBlobRef.current = null;
                      inputRef.current && (inputRef.current.value = "");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={async () => {
                      if (!croppedAreaPixels) return;
                      const blob = await getCroppedImg(
                        imageSrc,
                        croppedAreaPixels
                      );
                      console.log(
                        "[ProfileEditor] Cropped blob created:",
                        blob?.size,
                        "bytes"
                      );
                      pendingBlobRef.current = blob;
                      const previewUrl = URL.createObjectURL(blob);
                      setImageSrc(previewUrl);
                      onPreviewChange?.(previewUrl);
                      setOpen(false);
                      setIsEditing(false);
                      inputRef.current && (inputRef.current.value = "");
                    }}
                  >
                    Update
                  </Button>
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
});

export default ProfileImageEditor;
