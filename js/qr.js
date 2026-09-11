// js/qr.js
// Generation uses the `qrcode` UMD build (window.QRCode.toCanvas).
// Scanning uses `jsQR` against frames pulled from a live camera stream.
// Both loaded via CDN <script> tags in index.html.

function renderQrToCanvas(canvas, token) {
  // Guard against the CDN script not having loaded yet (slow network,
  // blocked domain, ad-blocker, etc). Without this, a thrown error here
  // would abort renderQrModal() before it wires up the Close button.
  if (!window.QRCode) {
    canvas.width = 220;
    canvas.height = 70;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fef2f2";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ef4444";
    ctx.font = "13px sans-serif";
    ctx.fillText("QR library failed to load.", 10, 28);
    ctx.fillText("Check your network/CDN access.", 10, 46);
    return;
  }
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

  // Wire up closing FIRST, before anything that could throw (e.g. the QR
  // library not being loaded). Previously the close handlers were attached
  // after renderQrToCanvas(), so a failure there left the modal with no way
  // to close it.
  document.getElementById("qr-modal-close").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

  renderQrToCanvas(document.getElementById("qr-modal-canvas"), token);
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
    if (!window.jsQR) {
      document.getElementById("qr-scan-error").textContent =
        "Scanner library failed to load. Please select manually below.";
      return;
    }
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
