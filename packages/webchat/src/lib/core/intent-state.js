// The app's one focus record (tools/docstore-kit/lib/intent.js) as a declaration. Which pane, which element in it, the caret and
// any pending move are this record's alone: components dispatch its transitions and read it, nothing else focuses or keeps a
// focused flag (kit lint `focus-outside-intent`, DOCSTORE3-DESIGN row 60). Ephemeral: a reload starts with nothing focused.
import { declare } from '../../../../runner/tools/docstore-kit/lib/model.js';
import { declareComponent } from '../../../../runner/tools/docstore-kit/lib/components.js';
import { intent } from '../../../../runner/tools/docstore-kit/lib/intent.js';

export const intentDecl = declare(declareComponent('intent', intent(), { scope: 'ephemeral' }));
