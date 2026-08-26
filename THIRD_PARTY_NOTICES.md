# Third-party notices

## Meetmate

This project directly reuses the Meetmate conversation pipeline, streaming
STT/TTS providers, agent gateway/session handling, barge-in, delegation, and
configuration modules from commit
`939a627d0d781ecb4ca4fc291eef0e9e456d59c5` of
<https://github.com/caty-ai/meetmate>.

Meetmate is Copyright (c) 2026 Shoji Kumaru and is licensed under the **MIT License**.
The dependency package retains its `LICENSE` and `NOTICE` files. Its
full MIT license text is also reproduced below so source and binary
distributions of this bridge retain the required notice.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Update owner: the bridge maintainers explicitly advance the pinned Git commit
after reviewing upstream changes and rerunning both-OS acceptance. Uninstall:
remove the `meetmate` dependency and reinstall packages; the Discord transport
remains separately owned by this project. No Meetmate instance-specific avatar
or generated filler audio is redistributed.
