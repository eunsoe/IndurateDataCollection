'''
Enter this into terminal -> pip install ultralytics opencv-python
Note: we do not have training datasets to train YOLO
'''

import cv2, time
from ultralytics import YOLO

# 1) Load a small model (start with yolov8n, swap in your trained weights later)
model = YOLO("yolov8n.pt")  # replace with "runs/detect/train/weights/best.pt" after training

CLASS_NAMES = {0: "induration", 1: "fiducial"}  # if you trained custom, these match your data.yaml order
CONF = 0.4

cap = cv2.VideoCapture(0)  # 0 = default webcam
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

def draw_box(img, xyxy, cls, conf, color=(0,255,0)):
    x1,y1,x2,y2 = map(int, xyxy)
    cv2.rectangle(img, (x1,y1), (x2,y2), color, 2)
    label = f"{cls} {conf:.2f}"
    cv2.putText(img, label, (x1, max(0,y1-6)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

mm_per_px = None  # set when fiducial detected (e.g., 50 mm real width / pixel width)
FIDUCIAL_MM = 50.0  # your printed marker width in mm

while True:
    ok, frame = cap.read()
    if not ok: break

    # 2) Inference (use smaller imgsz for speed if needed)
    results = model.predict(source=frame, imgsz=640, conf=CONF, verbose=False)[0]

    fiducial_px_w = None
    induration_box = None

    for box in results.boxes:
        cls_idx = int(box.cls.item())
        conf = float(box.conf.item())
        x1,y1,x2,y2 = box.xyxy[0].tolist()
        w = x2 - x1
        h = y2 - y1

        if CLASS_NAMES.get(cls_idx) == "fiducial":
            fiducial_px_w = max(w, h)  # whichever dimension your training favors
            draw_box(frame, (x1,y1,x2,y2), "fiducial", conf, (255,255,0))
        elif CLASS_NAMES.get(cls_idx) == "induration":
            induration_box = (x1,y1,x2,y2)
            draw_box(frame, (x1,y1,x2,y2), "induration", conf, (0,255,0))

    # 3) Compute mm/px if we see the fiducial
    if fiducial_px_w and fiducial_px_w > 0:
        mm_per_px = FIDUCIAL_MM / fiducial_px_w

    # 4) Overlay guidance
    h, w = frame.shape[:2]
    # Framing target: induration centered and ~desired size
    if induration_box:
        x1,y1,x2,y2 = induration_box
        cx, cy = int((x1+x2)/2), int((y1+y2)/2)
        cv2.circle(frame, (cx, cy), 6, (0,0,255), -1)
        cv2.putText(frame, "Center bump in circle", (20,40), 0, 0.8, (0,0,255), 2)

    # Distance guidance from mm/px
    if mm_per_px:
        # Example: want fiducial to be ~160 px wide (=> distance band)
        target_px = FIDUCIAL_MM / (mm_per_px if mm_per_px>0 else 1)
        cv2.putText(frame, f"Scale ~ {mm_per_px:.2f} mm/px  (target px≈{target_px:.0f})",
                    (20,80), 0, 0.7, (255,255,255), 2)

    cv2.imshow("YOLO feedback", frame)
    if cv2.waitKey(1) & 0xFF == 27:  # ESC to quit
        break

cap.release()
cv2.destroyAllWindows()
