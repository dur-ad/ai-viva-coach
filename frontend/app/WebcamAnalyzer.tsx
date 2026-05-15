"use client";

import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle, useCallback } from "react";
import Webcam from "react-webcam";
import { FaceLandmarker, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";

export interface WebcamAnalyzerRef {
  startTracking: () => void;
  stopTracking: () => number;
}

export interface AttentionStatus {
  lookingAway: boolean;   // head pose deviation
  noEyeContact: boolean;  // iris not centered
}

interface WebcamAnalyzerProps {
  onAttentionChange?: (status: AttentionStatus) => void;
}

const WebcamAnalyzer = forwardRef<WebcamAnalyzerRef, WebcamAnalyzerProps>((props, ref) => {
  const { onAttentionChange } = props;

  // --- Refs & State ---
  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [faceLandmarker, setFaceLandmarker] = useState<FaceLandmarker | null>(null);
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const isTrackingRef = useRef(false);
  const confidenceScoresRef = useRef<number[]>([]);
  const lastNosePosRef = useRef<{ x: number; y: number } | null>(null);

  // Strike counters for 3-strike rule (prevents flickering)
  const lookAwayStrikesRef = useRef(0);
  const noEyeContactStrikesRef = useRef(0);
  const STRIKE_THRESHOLD = 2; // 2 consecutive bad frames → trigger warning

  // 🔇 Suppress noisy MediaPipe WASM logs
  useEffect(() => {
    const originalError = console.error;
    console.error = (...args) => {
      const msg = args?.[0];
      if (
        typeof msg === "string" &&
        (msg.includes("vision_wasm_internal") ||
          msg.includes("XNNPACK delegate") ||
          msg.includes("Face blendshape") ||
          msg.includes("gl_context"))
      ) return;
      originalError(...args);
    };
    return () => { console.error = originalError; };
  }, []);

  // Expose start/stop methods to parent
  useImperativeHandle(ref, () => ({
    startTracking: () => {
      isTrackingRef.current = true;
      confidenceScoresRef.current = [];
      lastNosePosRef.current = null;
      lookAwayStrikesRef.current = 0;
      noEyeContactStrikesRef.current = 0;
    },
    stopTracking: () => {
      isTrackingRef.current = false;
      onAttentionChange?.({ lookingAway: false, noEyeContact: false });
      if (confidenceScoresRef.current.length === 0) return 100;
      const sum = confidenceScoresRef.current.reduce((a, b) => a + b, 0);
      return Math.round(sum / confidenceScoresRef.current.length);
    },
  }));

  // 🧠 Load FaceLandmarker
  useEffect(() => {
    async function loadModel() {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
      );
      const landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
          delegate: "CPU",
        },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      });
      setFaceLandmarker(landmarker);
      setIsModelLoaded(true);
    }
    loadModel();
  }, []);

  // ─── Attention Analysis Helpers ────────────────────────────────────────────

  /**
   * Head Pose Check – uses nose tip (1) relative to left eye (33) and right eye (263).
   * Returns true if the user appears to be looking away from the screen.
   */
  const checkHeadPose = useCallback((landmarks: { x: number; y: number; z: number }[]) => {
    const nose = landmarks[1];
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];

    const distLeft = Math.abs(nose.x - leftEye.x);
    const distRight = Math.abs(nose.x - rightEye.x);

    const ratio = distRight !== 0 ? distLeft / distRight : 1;
    // ratio < 0.55 → looking left; ratio > 1.65 → looking right
    return ratio < 0.55 || ratio > 1.65;
  }, []);

  /**
   * Eye Contact / Iris Check – uses iris landmarks (468–471 right, 473–477 left)
   * and eye corners to compute gaze ratio.
   * Returns true if BOTH eyes are NOT centered (looking away from camera).
   */
  const checkEyeContact = useCallback((landmarks: { x: number; y: number; z: number }[]) => {
    // MediaPipe iris landmarks (only available with iris refinement – they may not be present)
    // Right iris: 468, 469, 470, 471 | Right eye corners: 33 (inner), 133 (outer)
    // Left iris: 473, 474, 475, 476  | Left eye corners: 362 (inner), 263 (outer)
    if (landmarks.length < 478) return false; // iris landmarks not available

    const calcGazeRatio = (
      irisIndices: number[],
      leftCorner: number,
      rightCorner: number
    ) => {
      const irisX =
        irisIndices.reduce((sum, i) => sum + landmarks[i].x, 0) / irisIndices.length;
      const distLeft = Math.abs(irisX - landmarks[leftCorner].x);
      const distRight = Math.abs(irisX - landmarks[rightCorner].x);
      return distRight !== 0 ? distLeft / distRight : 1;
    };

    const rightRatio = calcGazeRatio([468, 469, 470, 471], 33, 133);
    const leftRatio = calcGazeRatio([473, 474, 475, 476], 362, 263);

    // Centered gaze ≈ 0.7–1.4; outside means looking away
    const rightLookingAway = rightRatio < 0.6 || rightRatio > 1.5;
    const leftLookingAway = leftRatio < 0.6 || leftRatio > 1.5;

    // Only flag if BOTH eyes are off-center (handles blinks/squints gracefully)
    return rightLookingAway && leftLookingAway;
  }, []);

  // ─── Main Analysis Loop ────────────────────────────────────────────────────
  useEffect(() => {
    if (!faceLandmarker) return;

    let animationFrameId: number;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;

    const drawingUtils = new DrawingUtils(ctx);
    let lastVideoTime = -1;
    let lastTimestamp = -1;
    let isProcessing = false;

    // Throttle: only run attention checks every ~1 second (not every frame)
    let lastAttentionCheck = 0;
    const ATTENTION_INTERVAL_MS = 1000;

    const predict = () => {
      const webcam = webcamRef.current;
      if (
        !webcam?.video ||
        webcam.video.readyState < 2 ||
        webcam.video.videoWidth === 0
      ) {
        animationFrameId = requestAnimationFrame(predict);
        return;
      }

      const video = webcam.video;

      if (
        canvasRef.current &&
        (canvasRef.current.width !== video.videoWidth ||
          canvasRef.current.height !== video.videoHeight)
      ) {
        canvasRef.current.width = video.videoWidth;
        canvasRef.current.height = video.videoHeight;
      }

      if (lastVideoTime !== video.currentTime) {
        lastVideoTime = video.currentTime;
        let startTimeMs = performance.now();
        if (startTimeMs <= lastTimestamp) startTimeMs = lastTimestamp + 1;
        lastTimestamp = startTimeMs;

        if (!isProcessing) {
          isProcessing = true;
          try {
            ctx.clearRect(0, 0, canvasRef.current!.width, canvasRef.current!.height);
            const results = faceLandmarker.detectForVideo(video, startTimeMs);

            if (results.faceLandmarks?.length > 0) {
              const landmarks = results.faceLandmarks[0];

              // Draw facial mesh
              drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_TESSELATION, {
                color: "#C0C0C070", lineWidth: 1,
              });
              drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, {
                color: "#FF3030", lineWidth: 2,
              });
              drawingUtils.drawConnectors(landmarks, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, {
                color: "#FF3030", lineWidth: 2,
              });

              // ── Confidence scoring (when tracking) ──
              if (isTrackingRef.current) {
                const attentionScore =
                  results.faceBlendshapes?.[0].categories.find(
                    (c) => c.categoryName === "eyeLookOutRight"
                  )?.score || 0;

                const nose = landmarks[4];
                let movementScore = 0;
                if (lastNosePosRef.current) {
                  movementScore =
                    Math.abs(nose.x - lastNosePosRef.current.x) +
                    Math.abs(nose.y - lastNosePosRef.current.y);
                }
                lastNosePosRef.current = { x: nose.x, y: nose.y };

                const frameConfidence = 100 - attentionScore * 200 - movementScore * 300;
                confidenceScoresRef.current.push(Math.max(0, Math.min(100, frameConfidence)));
              }

              // ── Live attention alerts (1-second pulse + 2-strike rule) ──
              const now = performance.now();
              if (now - lastAttentionCheck >= ATTENTION_INTERVAL_MS) {
                lastAttentionCheck = now;

                const headAway = checkHeadPose(landmarks);
                const eyesAway = checkEyeContact(landmarks);

                // 3-strike accumulator
                lookAwayStrikesRef.current = headAway
                  ? lookAwayStrikesRef.current + 1
                  : 0;
                noEyeContactStrikesRef.current = eyesAway
                  ? noEyeContactStrikesRef.current + 1
                  : 0;

                onAttentionChange?.({
                  lookingAway: lookAwayStrikesRef.current >= STRIKE_THRESHOLD,
                  noEyeContact: noEyeContactStrikesRef.current >= STRIKE_THRESHOLD,
                });
              }
            } else {
              // No face detected – reset strikes
              lookAwayStrikesRef.current = 0;
              noEyeContactStrikesRef.current = 0;
              onAttentionChange?.({ lookingAway: false, noEyeContact: false });
            }
          } catch (err) {
            console.warn("MediaPipe crashed on this frame, skipping:", err);
          }
          isProcessing = false;
        }
      }

      animationFrameId = requestAnimationFrame(predict);
    };

    predict();
    return () => cancelAnimationFrame(animationFrameId);
  }, [faceLandmarker, checkHeadPose, checkEyeContact, onAttentionChange]);

  // --- UI ---
  return (
    <div className="relative aspect-video rounded-xl overflow-hidden border-2 border-slate-200 bg-slate-900 shadow-inner">
      {!isModelLoaded && (
        <div className="absolute inset-0 flex items-center justify-center text-white text-sm animate-pulse z-10 bg-slate-900">
          Loading Vision AI...
        </div>
      )}
      <Webcam
        ref={webcamRef}
        mirrored
        audio={false}
        className="absolute inset-0 w-full h-full object-cover"
        videoConstraints={{ width: 640, height: 480, facingMode: "user" }}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full object-cover z-0"
        style={{ transform: "scaleX(-1)" }}
      />
      {isTrackingRef.current && (
        <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-rose-600 text-white px-2.5 py-1 rounded-full font-bold text-xs animate-pulse z-10 shadow-lg">
          <div className="w-2 h-2 rounded-full bg-white" />
          ANALYZING BEHAVIOR
        </div>
      )}
    </div>
  );
});

WebcamAnalyzer.displayName = "WebcamAnalyzer";
export default WebcamAnalyzer;