/** Calendar day in the notes' local timezone, with a 4 a.m. boundary (including DST). */
export function notesDay(at = new Date()) {
  const day = new Date(at);
  if (day.getHours() < 4) day.setDate(day.getDate() - 1);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}
