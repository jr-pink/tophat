import { error } from '@sveltejs/kit';

// /s with no token is not the app; it is a dead share link, and it renders the +error.svelte
// beside this file rather than falling through to the application shell.
export function load() {
  error(404, 'This link is not live');
}
