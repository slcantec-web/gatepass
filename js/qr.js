// js/qr.js
// Generation uses the `qrcode` UMD build (window.QRCode.toCanvas).
// Scanning uses `jsQR` against frames pulled from a live camera stream.
// Both loaded via CDN <script> tags in index.html.

function renderQrToCanvas(canvas, token) {
  // Encode just the opaque token - short, and the /api/qr/:token endpoint
  // resolves it server-side to either a location or a pass (section 13).
  window.QRCode.toCanvas(canvas, token, { width: 220, margin: 1 }, (err) => {
    if (err) console.error("QR render failed", err);
  });
}

function renderQrModal(title, token) {
  const modal = document.createElement("div");
  modal.className = "qr-modal-backdrop";
  modal.innerHTML = `
    <div class="qr-modal">
      <h3>${title}</h3>
      <canvas id="qr-modal-canvas"></canvas>
      <p class="qr-token">${token}</p>
      <button id="qr-modal-close">Close</button>
    </div>
  `;
  document.body.appendChild(modal);
  renderQrToCanvas(document.getElementById("qr-modal-canvas"), token);
  document.getElementById("qr-modal-close").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

// Opens a camera scanner in a modal. Calls onResult(token) once a QR is
// decoded, then stops the camera and closes itself. Calling code decides
// what to do with the resolved token via Api call to /api/qr/:token.
function openQrScanner(onResult) {
  const modal = document.createElement("div");
  modal.className = "qr-modal-backdrop";
  modal.innerHTML = `
    <div class="qr-modal">
      <h3>Scan QR Code</h3>
      <video id="qr-scan-video" playsinline muted></video>
      <canvas id="qr-scan-canvas" style="display:none;"></canvas>
      <div id="qr-scan-error" class="error-text"></div>
      <button id="qr-scan-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(modal);

  const video = document.getElementById("qr-scan-video");
  const canvas = document.getElementById("qr-scan-canvas");
  const ctx = canvas.getContext("2d");
  let stream = null;
  let stopped = false;

  function cleanup() {
    stopped = true;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    modal.remove();
  }
  document.getElementById("qr-scan-cancel").addEventListener("click", cleanup);

  function tick() {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(imageData.data, imageData.width, imageData.height);
      if (code && code.data) {
        cleanup();
        onResult(code.data);
        return;
      }
    }
    requestAnimationFrame(tick);
  }

  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
    .then((s) => {
      stream = s;
      video.srcObject = stream;
      video.play();
      requestAnimationFrame(tick);
    })
    .catch((err) => {
      document.getElementById("qr-scan-error").textContent =
        "Camera access failed: " + err.message + " (you can still select manually below).";
    });
}
