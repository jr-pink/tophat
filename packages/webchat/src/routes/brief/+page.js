// old links and bookmarks go to the chats.
import { redirect } from '@sveltejs/kit';

export function load() {
  redirect(307, '/?stay');
}
