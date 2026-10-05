import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const base = process.env.TWLA_PREVIEW_URL || 'http://localhost:4000/';

test('the new hand-pose demonstration serves the supplied, unmodified MP4', async () => {
  const response = await fetch(new URL('resources/videos/1193_Mesh.mp4', base));
  assert.equal(response.status, 200, 'Hand-pose video must be reachable');
  assert.match(response.headers.get('content-type') || '', /video\/mp4/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    'f202a3c026699359b9aba5cf79a21d4cf9d5b50e35a66db3e50d0287edc60348');
});

test('the paper overview image is served as a genuine PNG', async () => {
  const response = await fetch(new URL('resources/images/method-overview.png', base));
  assert.equal(response.status, 200, 'Method figure must be reachable');
  assert.match(response.headers.get('content-type') || '', /image\/png/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.readUInt32BE(16) >= 1800, 'Method labels need a high-resolution image');
});

test('all nine existing robot recordings and matching 3D assets remain reachable', async () => {
  const response = await fetch(new URL('resources/robot/manifest.json', base));
  assert.equal(response.status, 200);
  const clips = await response.json();
  assert.equal(clips.length, 9);
  assert.deepEqual([...new Set(clips.map(clip => clip.task))].sort(), ['Bag', 'Cup', 'Paper']);
  for (const clip of clips) {
    for (const resource of ['sync.mp4', 'sync_poster.jpg', 'robot.glb']) {
      const media = await fetch(new URL(clip.path + resource, base), { method: 'HEAD' });
      assert.equal(media.status, 200, `${clip.id}: ${resource}`);
      assert.ok(Number(media.headers.get('content-length')) > 0);
    }
  }
});

test('the removed named-author paper is no longer served by the website', async () => {
  const response = await fetch(new URL('resources/t_wla-paper.pdf', base));
  assert.equal(response.status, 404, 'The old paper URL must not expose author names');
});
