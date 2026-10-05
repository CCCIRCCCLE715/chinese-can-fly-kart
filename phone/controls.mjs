// Each contact is tracked independently, including duplicated shoulder buttons.
export function createButtonState() {
 const contacts = new Map();
 return {
  press(action, contact) { contacts.set(contact, action); },
  release(contact) { contacts.delete(contact); },
  clear() { contacts.clear(); },
  held(action) { return [...contacts.values()].includes(action); }
 };
}
export function stickPosition(x, y, radius) {
 const scale = Math.min(1, radius / Math.max(radius, Math.hypot(x, y)));
 const dx = x * scale, dy = y * scale;
 const axis = dx / radius;
 return { x: dx, y: dy, steer: Math.abs(axis) < .08 ? 0 : Math.sign(axis) * (Math.abs(axis) - .08) / .92 };
}
