'use strict';
// Base64 queue ingress lands in temp files first (Codex review 1e96b5fc94a6
// R6). POST /youtube/queue used to overwrite <id>.mp4, its thumbnail and its
// text-fit receipt in the staging dir before the release gate or the
// held-bytes binding had looked at them, so a request the server then
// refused with 409 had already replaced the files a queued or held row
// pointed at. The temps sit beside the final names (the gate needs the
// receipt next to the video it proves), are committed by rename only once
// every check has passed, and are discarded otherwise.
const fs = require('node:fs');
const path = require('node:path');

function stageQueueIngressFiles({ dir, id, body = {}, fsImpl = fs, tag = `${process.pid}-${Date.now()}` } = {}) {
  if (!dir || !id) throw new Error('queue ingress staging needs the staging dir and the item id');
  const finalVideoPath = path.join(dir, `${id}.mp4`);
  const finalThumbPath = path.join(dir, `${id}_thumb.jpg`);
  const moves = [];
  let videoPath = body.videoPath || null;
  let thumbnailPath = body.thumbnailPath;
  let textFitReceiptPath = body.textFitReceiptPath;
  let finalReceiptPath = textFitReceiptPath;
  if (body.videoBase64) {
    const tempVideoPath = path.join(dir, `${id}.ingress-${tag}.mp4`);
    fsImpl.writeFileSync(tempVideoPath, Buffer.from(String(body.videoBase64), 'base64'));
    moves.push([tempVideoPath, finalVideoPath]);
    videoPath = tempVideoPath;
  }
  if (body.thumbnailBase64) {
    const tempThumbPath = path.join(dir, `${id}.ingress-${tag}_thumb.jpg`);
    fsImpl.writeFileSync(tempThumbPath, Buffer.from(String(body.thumbnailBase64), 'base64'));
    moves.push([tempThumbPath, finalThumbPath]);
    thumbnailPath = tempThumbPath;
  }
  if (body.textFitReceiptBase64 && videoPath) {
    // The receipt is proved beside the video it belongs to and committed to
    // the name the release gate resolves by default (<video>.text-fit.json).
    const receiptBase = body.videoBase64 ? finalVideoPath : String(videoPath);
    const tempReceiptPath = path.join(
      path.dirname(receiptBase),
      `${path.basename(receiptBase)}.ingress-${tag}.text-fit.json`,
    );
    fsImpl.writeFileSync(tempReceiptPath, Buffer.from(String(body.textFitReceiptBase64), 'base64'));
    finalReceiptPath = `${receiptBase}.text-fit.json`;
    moves.push([tempReceiptPath, finalReceiptPath]);
    textFitReceiptPath = tempReceiptPath;
  }
  if (body.videoBase64 && !textFitReceiptPath) {
    // No receipt in this push: the one already beside the final name (a
    // prior push of the same bytes) is the only candidate. The gate binds it
    // to the staged bytes by SHA-256, so other bytes still fail.
    textFitReceiptPath = `${finalVideoPath}.text-fit.json`;
    finalReceiptPath = textFitReceiptPath;
  }
  const finalPaths = {
    videoPath: body.videoBase64 ? finalVideoPath : videoPath,
    thumbnailPath: body.thumbnailBase64 ? finalThumbPath : thumbnailPath,
    textFitReceiptPath: finalReceiptPath,
  };
  let committed = false;
  let discarded = false;
  return {
    staged: moves.length > 0,
    videoPath,
    thumbnailPath,
    textFitReceiptPath,
    finalPaths,
    commit() {
      if (committed) return finalPaths;
      for (const [temp] of moves) {
        if (!fsImpl.existsSync(temp)) {
          throw new Error(`queue ingress staging for ${id} was discarded or is missing: ${temp}`);
        }
      }
      for (const [temp, finalPath] of moves) fsImpl.renameSync(temp, finalPath);
      committed = true;
      return finalPaths;
    },
    discard() {
      if (committed || discarded) return;
      discarded = true;
      for (const [temp] of moves) {
        try {
          if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp);
        } catch {
          // A temp that cannot be removed is never a reason to fail the refusal.
        }
      }
    },
  };
}

module.exports = { stageQueueIngressFiles };
