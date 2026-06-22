/**
 * Operational Transformation (OT) Engine
 * Implements a character-level Jupiter-style OT for text documents.
 * 
 * Supports two core operations:
 * 1. Insert: { type: 'insert', index: Number, text: String, clientId: String }
 * 2. Delete: { type: 'delete', index: Number, text: Number (length), clientId: String }
 */

class OT {
  /**
   * Applies an operation to a string document state and returns the new string.
   */
  static apply(doc, op) {
    if (!op) return doc;
    const { type, index } = op;
    
    if (index < 0 || index > doc.length) {
      // Out of bounds safety guard
      console.warn(`[OT] Operation index ${index} out of bounds for doc of length ${doc.length}`);
      return doc;
    }

    if (type === 'insert') {
      return doc.slice(0, index) + op.text + doc.slice(index);
    } else if (type === 'delete') {
      const len = typeof op.text === 'number' ? op.text : op.text.length;
      return doc.slice(0, index) + doc.slice(index + len);
    }
    
    return doc;
  }

  /**
   * Transforms operation A against operation B (which was applied concurrently).
   * Returns A' (A transformed) such that: apply(apply(S, B), A') == apply(apply(S, A), B')
   * 
   * @param {Object} opA - Operation to transform
   * @param {Object} opB - Concurrent operation already applied
   * @returns {Object|null} Transformed operation, or null if it becomes a no-op
   */
  static transform(opA, opB) {
    if (!opA) return null;
    if (!opB) return opA;

    const typeA = opA.type;
    const typeB = opB.type;
    const posA = opA.index;
    const posB = opB.index;

    // --- CASE 1: INSERT vs INSERT ---
    if (typeA === 'insert' && typeB === 'insert') {
      const lenB = opB.text.length;
      if (posA < posB) {
        // A is before B. Unaffected.
        return { ...opA };
      } else if (posA > posB) {
        // A is after B. Shift A right.
        return { ...opA, index: posA + lenB };
      } else {
        // Equal position. Tie-break using Client ID lexicographical comparison
        if (opA.clientId < opB.clientId) {
          // A wins. A stays at original index.
          return { ...opA };
        } else {
          // B wins. A shifts right past B's insertion.
          return { ...opA, index: posA + lenB };
        }
      }
    }

    // --- CASE 2: DELETE vs DELETE ---
    if (typeA === 'delete' && typeB === 'delete') {
      const lenA = typeof opA.text === 'number' ? opA.text : opA.text.length;
      const lenB = typeof opB.text === 'number' ? opB.text : opB.text.length;

      const endA = posA + lenA;
      const endB = posB + lenB;

      if (endA <= posB) {
        // A is entirely before B. Unaffected.
        return { ...opA };
      }
      
      if (posA >= endB) {
        // A is entirely after B. Shift A left.
        return { ...opA, index: posA - lenB };
      }

      // Overlap cases
      let newStart = posA;
      let newEnd = endA;

      if (posB < posA) {
        // B started before A. Shift A's start left.
        newStart = posB;
      }
      
      // Calculate how many characters are left to delete
      // Characters deleted by B are already gone.
      const overlapStart = Math.max(posA, posB);
      const overlapEnd = Math.min(endA, endB);
      const overlapLen = overlapEnd - overlapStart;

      const remainingLen = lenA - overlapLen;
      if (remainingLen <= 0) {
        return null; // A's delete was completely swallowed by B
      }

      // Shift position based on B's delete before A's start
      const shift = Math.min(posA - posB, lenB);
      return {
        ...opA,
        index: posA - Math.max(0, shift),
        text: remainingLen
      };
    }

    // --- CASE 3: INSERT vs DELETE ---
    if (typeA === 'insert' && typeB === 'delete') {
      const lenB = typeof opB.text === 'number' ? opB.text : opB.text.length;
      const endB = posB + lenB;

      if (posA <= posB) {
        // Insert is before or at the start of Delete. Unaffected.
        return { ...opA };
      } else if (posA >= endB) {
        // Insert is after Delete. Shift left.
        return { ...opA, index: posA - lenB };
      } else {
        // Insert falls strictly inside Delete range. It is swallowed (cancelled).
        return null;
      }
    }

    // --- CASE 4: DELETE vs INSERT ---
    if (typeA === 'delete' && typeB === 'insert') {
      const lenA = typeof opA.text === 'number' ? opA.text : opA.text.length;
      const lenB = opB.text.length;
      const endA = posA + lenA;

      if (endA <= posB) {
        // Delete is entirely before Insert. Unaffected.
        return { ...opA };
      } else if (posA >= posB) {
        // Delete starts at or after Insert. Shift right.
        return { ...opA, index: posA + lenB };
      } else {
        // Insert falls inside Delete range.
        // We expand the delete length to swallow the newly inserted characters.
        return {
          ...opA,
          text: lenA + lenB
        };
      }
    }

    return opA;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OT;
}
