```
Expo/React Native capture screen with NO machine learning.
- Guides user through 6 angles using device motion
- Requires a QR fiducial in frame (uses Expo Camera barcode scanner)
- Captures JPEGs and uploads to S3 via your Node backend presigned URLs
- Records metadata to backend
```
import { useEffect, useRef, useState, useMemo } from "react";
import { View, Text, TouchableOpacity, Alert, StysleSheet, Platform } from "react-native";
import { Camera, CameraType } from "expo-camera";
import * as DeviceMotion from "expo-sensors";
import * as FileSystem from "expo-file-system";

// ---- CONFIG ----
const API_BASE = "http://localhost:8080"; // change for your server
const API_KEY = "super-secret-key-change-me"; // match your backend .env
const TARGET_ANGLES = [0, -15, -30, 15, 30, 90];
const ANGLE_TOL = 5; // degrees

// Helper to call backend
async function api(path: string, body: any) {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

export default function CaptureNoML() {
  const cameraRef = useRef<Camera | null>(null);
  const [camPerm, requestCamPerm] = Camera.useCameraPermissions();
  const [yawDeg, setYawDeg] = useState(0);
  const [pitchDeg, setPitchDeg] = useState(0);
  const [rollDeg, setRollDeg] = useState(0);
  const [angleIdx, setAngleIdx] = useState(0);
  const [sessionId, setSessionId] = useState(() => `TST${new Date().toISOString().slice(0,10).replaceAll('-','')}-${Math.floor(Math.random()*900+100)}`);
  const [site] = useState<"LForearm"|"RForearm">("RForearm");
  const [qrSeen, setQrSeen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (!camPerm?.granted) await requestCamPerm();
      // Create session on backend once
      try {
        await api("/sessions", { sessionId, operatorId: "op_demo", site, anglesDeg: TARGET_ANGLES, consent: true });
      } catch (e) {
        console.log("session create:", e);
      }
    })();
  }, []);

  // Device motion for angles
  useEffect(() => {
    DeviceMotion.setUpdateInterval(100);
    const sub = DeviceMotion.addListener(({ rotation }) => {
      if (!rotation) return;
      // On iOS, rotation.alpha/beta/gamma are in radians; mapping can vary by orientation.
      // We'll use gamma for yaw-like guidance; adjust as needed after quick testing on device.
      const yaw = (rotation.gamma ?? 0) * (180/Math.PI);
      const pitch = (rotation.beta ?? 0) * (180/Math.PI);
      const roll = (rotation.alpha ?? 0) * (180/Math.PI);
      setYawDeg(yaw);
      setPitchDeg(pitch);
      setRollDeg(roll);
    });
    return () => sub.remove();
  }, []);

  const targetAngle = TARGET_ANGLES[angleIdx];
  const angleOk = useMemo(() => Math.abs(yawDeg - targetAngle) <= ANGLE_TOL, [yawDeg, targetAngle]);
  const canCapture = angleOk && qrSeen && !busy;

  const onBarcodesScanned = ({ barcodes }: any) => {
    // Expo Camera V3 barcode scanner provides an array of detected barcodes per frame
    // We accept any QR seen as fiducial presence
    const hasQR = barcodes?.some((b: any) => b?.format === "qr" || b?.type === "org.iso.QRCode");
    setQrSeen(Boolean(hasQR));
  };

  async function captureAndUpload() {
    if (!cameraRef.current) return;
    if (!canCapture) {
      Alert.alert("Not ready", !qrSeen ? "Show the QR fiducial in frame" : `Match ${targetAngle}° ±${ANGLE_TOL}°`);
      return;
    }
    try {
      setBusy(true);
      const tsIso = new Date().toISOString();
      const photo = await cameraRef.current.takePictureAsync({ quality: 1, exif: true, skipProcessing: false });

      // 1) Ask backend for a presigned URL
      const signed = await api("/uploads/sign", {
        sessionId, site, angleDeg: targetAngle, timestampIso: tsIso, kind: "image"
      });

      // 2) Upload the JPEG to S3 via presigned URL
      const putRes = await FileSystem.uploadAsync(signed.url, photo.uri, {
        httpMethod: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT
      });
      if (putRes.status !== 200) throw new Error(`S3 PUT failed: ${putRes.status}`);

      // 3) Inform backend about this image + basic capture metadata
      await api("/images", {
        sessionId,
        site,
        angleDeg: targetAngle,
        s3Key: signed.key,
        filename: signed.key.split("/").pop(),
        capture: { yawDeg, pitchDeg, rollDeg, glarePct: 0, sharpness: 0 }, // QC placeholders (no ML, no pixel ops)
        fiducial: { type: "qr", mm: 50 },
        timestampIso: tsIso
      });

      // 4) Advance angle pointer
      if (angleIdx < TARGET_ANGLES.length - 1) setAngleIdx(angleIdx + 1);
      else {
        await api(`/sessions/${sessionId}/complete`, {});
        Alert.alert("Done", "Captured all angles and uploaded");
      }
    } catch (e: any) {
      console.error(e);
      Alert.alert("Upload error", String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: "black" }}>
      <Camera
        ref={(r) => (cameraRef.current = r)}
        style={{ flex: 1 }}
        type={CameraType.back}
        ratio={Platform.OS === 'ios' ? '16:9' : undefined}
        autofocus={"on"}
        whiteBalance={"auto"}
        zoom={0}
        // @ts-ignore new barcode props in SDK 51+
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodesScanned={onBarcodesScanned}
      />

      {/* HUD overlay */}
      <View style={styles.hud}>
        <Text style={styles.hudText}>Session: {sessionId}</Text>
        <Text style={styles.hudText}>Target: {targetAngle}°  |  Yaw: {yawDeg.toFixed(1)}°</Text>
        <Text style={[styles.hudText, { color: qrSeen ? "#4ade80" : "#f87171" }]}>QR fiducial: {qrSeen ? "seen" : "not seen"}</Text>

        <TouchableOpacity disabled={!canCapture} onPress={captureAndUpload} style={[styles.captureBtn, { opacity: canCapture ? 1 : 0.5 }]}>
          <Text style={{ fontSize: 18 }}>{busy ? "Uploading..." : "Capture"}</Text>
        </TouchableOpacity>

        <View style={styles.progressRow}>
          {TARGET_ANGLES.map((a, i) => (
            <View key={i} style={[styles.dot, i < angleIdx ? styles.dotDone : i === angleIdx ? (angleOk && qrSeen ? styles.dotReady : styles.dotActive) : styles.dotIdle]} />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hud: { position: "absolute", bottom: 24, left: 0, right: 0, alignItems: "center", gap: 6 },
  hudText: { color: "white", fontSize: 14 },
  captureBtn: { marginTop: 8, backgroundColor: "white", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 999 },
  progressRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: "#aaa" },
  dotIdle: { backgroundColor: "#374151" },
  dotActive: { backgroundColor: "#fbbf24" },
  dotReady: { backgroundColor: "#34d399" },
  dotDone: { backgroundColor: "#22c55e" },
});
