// A ceiling on what a harness can put into this node's memory.
//
// The run loop accumulated stdout with `+=` and no limit. An agent that streams
// for a long time, loops, or cats a large file grew the node without bound — the
// same shape as the unbounded request body a critic used to drive it to 777 MB,
// except this one arrives from a process the person deliberately started, so no
// hostility is required to trigger it.
//
// Truncating has to stay HONEST. The receipt records a byte count and a hash of
// the output, so a truncated capture must report that it was truncated and must
// report the bytes the harness actually PRODUCED — not the smaller number that
// happened to be kept. A shorter string presented as the whole output would make
// the receipt disagree with what ran.
//
// The beginning is what survives: a harness states what it is doing first, and a
// person reading a truncated capture needs the opening, not the tail.
//
// Owner layer: CLI.

const MAX_HARNESS_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Append a chunk to a bounded buffer.
 *
 * `buffer` is `{ text, bytes, truncated }` or null to start. `bytes` counts
 * everything received, including what was dropped.
 */
function boundedAppend(buffer, chunk) {
  const held = buffer || { text: '', bytes: 0, truncated: false, kept: 0 };
  const piece = chunk == null ? '' : String(chunk);
  if (!piece) return held;

  const pieceBytes = Buffer.byteLength(piece);
  const produced = held.bytes + pieceBytes;
  if (held.truncated) {
    // Still count it; the run really did produce it.
    return { text: held.text, bytes: produced, truncated: true, kept: held.kept };
  }

  // `kept` is carried rather than recomputed. Measuring the accumulated buffer on
  // every chunk made this O(n²): an independent critic measured 83 KB/s of
  // absorbable stdout and 23.7s of CPU to reach the ceiling in small chunks. The
  // node is single-threaded, so that CPU competes with /cancel — which would
  // weaken the cancellation repair shipped alongside this.
  const keptSoFar = held.kept ?? Buffer.byteLength(held.text);
  const room = MAX_HARNESS_OUTPUT_BYTES - keptSoFar;
  if (pieceBytes <= room) {
    return { text: held.text + piece, bytes: produced, truncated: false, kept: keptSoFar + pieceBytes };
  }
  // Cut the straddling chunk rather than dropping it whole, so the boundary is
  // not an arbitrary loss of a whole read.
  const fits = Buffer.from(piece).subarray(0, Math.max(0, room)).toString();
  return {
    text: held.text + fits, bytes: produced, truncated: true,
    kept: keptSoFar + Buffer.byteLength(fits),
  };
}

module.exports = { boundedAppend, MAX_HARNESS_OUTPUT_BYTES };
