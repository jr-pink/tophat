// Dev only: a local stand-in for the model API, so a demo instance can be driven end to end without spend. Slow, streamed
// replies (so an interrupt lands mid-answer). Prints its URL.
import { startFakeProvider, textReply, lastUserText } from '../../runner/rev5/fake-provider.mjs';
const fake = await startFakeProvider({ reply: (body) => textReply(`(dev model) You said: "${lastUserText(body).slice(0, 200)}". ${'This is a deliberately long streamed reply so there is time to interrupt it. '.repeat(8)}`) });
fake.state.delayMs = 120;
console.log(fake.url);
