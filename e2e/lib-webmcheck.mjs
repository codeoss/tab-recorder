/**
 * 独立 EBML 校验器：不调用生产解析逻辑，精确验证 SeekHead 三项、
 * CueTrack/CueTime/Cluster 落点、视频关键帧、Segment 尺寸，以及修复前后
 * Cluster 负载不变；已有 Cues 不得被算进 unknown-size Cluster 负载。
 */
const ID = {
  EBML: 0x1A45DFA3,
  SEGMENT: 0x18538067,
  SEEKHEAD: 0x114D9B74,
  SEEK: 0x4DBB,
  SEEKID: 0x53AB,
  SEEKPOS: 0x53AC,
  INFO: 0x1549A966,
  TRACKS: 0x1654AE6B,
  CLUSTER: 0x1F43B675,
  TIMECODE: 0xE7,
  CUES: 0x1C53BB6B,
  CUEPOINT: 0xBB,
  CUETIME: 0xB3,
  CUETRACKPOS: 0xB7,
  CUECLUSTER: 0xF1,
  CUETRACK: 0xF7,
  TRACKENTRY: 0xAE,
  TRACKNUMBER: 0xD7,
  TRACKTYPE: 0x83,
  SIMPLEBLOCK: 0xA3,
  BLOCKGROUP: 0xA0,
  BLOCK: 0xA1,
  REFERENCEBLOCK: 0xFB,
};
const NAME = Object.fromEntries(Object.entries(ID).map(([name, id]) => [id, name]));

function readId(b, off) {
  if (off >= b.length) return null;
  const x = b[off];
  const len = x & 0x80 ? 1 : x & 0x40 ? 2 : x & 0x20 ? 3 : x & 0x10 ? 4 : 0;
  if (!len || off + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[off + i];
  return { id, len };
}

function readSize(b, off) {
  if (off >= b.length) return null;
  const x = b[off];
  let len = 0;
  for (let i = 0; i < 8; i++) if (x & (0x80 >>> i)) { len = i + 1; break; }
  if (!len || off + len > b.length) return null;
  let value = x & ((1 << (8 - len)) - 1);
  let unknown = value === ((1 << (8 - len)) - 1);
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[off + i];
    if (b[off + i] !== 0xFF) unknown = false;
  }
  return { value, len, unknown };
}

function readElement(b, off) {
  const id = readId(b, off);
  if (!id) return null;
  const size = readSize(b, off + id.len);
  if (!size) return null;
  const dataOff = off + id.len + size.len;
  return {
    id: id.id,
    off,
    dataOff,
    size: size.value,
    unknown: size.unknown,
    end: size.unknown ? b.length : dataOff + size.value,
  };
}

function uint(b, off, len) {
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + b[off + i];
  return value;
}

function children(b, start, end) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const el = readElement(b, pos);
    if (!el || el.unknown || el.end > end || el.end <= pos) break;
    out.push(el);
    pos = el.end;
  }
  return out;
}

function completeChildren(b, start, end) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const el = readElement(b, pos);
    if (!el || el.unknown || el.end > end || el.end <= pos) return null;
    out.push(el);
    pos = el.end;
  }
  return out;
}

function findCues(b) {
  const signature = Buffer.from([0x1C, 0x53, 0xBB, 0x6B]);
  let at = b.length;
  while ((at = b.lastIndexOf(signature, at - 1)) >= 0) {
    const el = readElement(b, at);
    if (el && !el.unknown && el.end === b.length) return el;
  }
  return null;
}

function cueEntries(b, cues) {
  const out = [];
  for (const point of children(b, cues.dataOff, cues.end)) {
    if (point.id !== ID.CUEPOINT) continue;
    const pointChildren = children(b, point.dataOff, point.end);
    const time = pointChildren.find(x => x.id === ID.CUETIME);
    const trackPos = pointChildren.find(x => x.id === ID.CUETRACKPOS);
    if (!time || !trackPos) continue;
    const positions = children(b, trackPos.dataOff, trackPos.end);
    const cluster = positions.find(x => x.id === ID.CUECLUSTER);
    const track = positions.find(x => x.id === ID.CUETRACK);
    if (!cluster || !track) continue;
    out.push({
      time: uint(b, time.dataOff, time.end - time.dataOff),
      track: uint(b, track.dataOff, track.end - track.dataOff),
      clusterPosition: uint(b, cluster.dataOff, cluster.end - cluster.dataOff),
    });
  }
  return out;
}

function videoTrackNumber(b, segment) {
  for (let pos = segment.dataOff; pos < b.length;) {
    const el = readElement(b, pos);
    if (!el || el.unknown || el.id === ID.CLUSTER) break;
    if (el.id === ID.TRACKS) {
      for (const entry of children(b, el.dataOff, el.end)) {
        if (entry.id !== ID.TRACKENTRY) continue;
        const fields = children(b, entry.dataOff, entry.end);
        const number = fields.find(x => x.id === ID.TRACKNUMBER);
        const type = fields.find(x => x.id === ID.TRACKTYPE);
        if (number && type && uint(b, type.dataOff, type.end - type.dataOff) === 1) {
          return uint(b, number.dataOff, number.end - number.dataOff);
        }
      }
    }
    if (el.end <= pos) break;
    pos = el.end;
  }
  return 0;
}

function videoBlock(b, block, trackNumber, clusterTime) {
  const track = readSize(b, block.dataOff);
  if (!track || track.value !== trackNumber || block.dataOff + track.len + 3 > block.end) return null;
  const at = block.dataOff + track.len;
  const rawTime = (b[at] << 8) | b[at + 1];
  return {
    time: clusterTime + (rawTime & 0x8000 ? rawTime - 0x10000 : rawTime),
    flags: b[at + 2],
  };
}

function clusterKeyframe(b, cluster, trackNumber, mediaEnd) {
  const end = cluster.unknown ? mediaEnd : cluster.end;
  let clusterTime = null;
  for (let pos = cluster.dataOff; pos < end;) {
    const child = readElement(b, pos);
    if (!child || child.unknown || child.end > end || child.end <= pos) break;
    if (child.id === ID.CLUSTER || child.id === ID.CUES) break;
    if (child.id === ID.TIMECODE) {
      if (child.end - child.dataOff < 1 || child.end - child.dataOff > 8) break;
      clusterTime = uint(b, child.dataOff, child.end - child.dataOff);
    } else if (child.id === ID.SIMPLEBLOCK) {
      if (clusterTime === null) { pos = child.end; continue; }
      const block = videoBlock(b, child, trackNumber, clusterTime);
      if (block && (block.flags & 0x80)) return block;
    } else if (child.id === ID.BLOCKGROUP) {
      if (clusterTime === null) { pos = child.end; continue; }
      const group = completeChildren(b, child.dataOff, child.end);
      if (!group) break;
      if (!group.some(x => x.id === ID.REFERENCEBLOCK)) {
        for (const item of group) {
          if (item.id !== ID.BLOCK) continue;
          const block = videoBlock(b, item, trackNumber, clusterTime);
          if (block) return block;
        }
      }
    }
    pos = child.end;
  }
  return null;
}

export function checkWebMKeyframeCues(b) {
  const errors = [];
  const ebml = readElement(b, 0);
  const segment = ebml && readElement(b, ebml.end);
  if (!segment || segment.id !== ID.SEGMENT) return { errors: ['缺 Segment'], cues: [], cueTimes: [] };
  const trackNumber = videoTrackNumber(b, segment);
  const cues = findCues(b);
  if (!trackNumber) errors.push('未找到视频 TrackNumber');
  if (!cues) errors.push('文件尾缺 Cues');
  const entries = cues ? cueEntries(b, cues) : [];
  if (!entries.length) errors.push('Cues 没有有效 CuePoint');
  for (const cue of entries) {
    if (cue.track !== trackNumber) {
      errors.push(`Cue(${cue.time}) Track=${cue.track}，视频轨=${trackNumber}`);
      continue;
    }
    const cluster = readElement(b, segment.dataOff + cue.clusterPosition);
    const keyframe = cluster && cluster.id === ID.CLUSTER
      ? clusterKeyframe(b, cluster, trackNumber, cues.off) : null;
    if (!keyframe) errors.push(`Cue(${cue.time}) 未指向视频关键帧`);
    else if (keyframe.time !== cue.time) {
      errors.push(`CueTime=${cue.time}，关键帧时间=${keyframe.time}`);
    }
  }
  return { errors, cues: entries, cueTimes: entries.map(x => x.time) };
}

export function checkWebMSeekStructure(b) {
  const errors = [];
  const ebml = readElement(b, 0);
  if (!ebml || ebml.id !== ID.EBML) return { errors: ['缺 EBML 头'], cueTimes: [] };
  const segment = readElement(b, ebml.end);
  if (!segment || segment.id !== ID.SEGMENT) return { errors: ['缺 Segment'], cueTimes: [] };
  const segDataStart = segment.dataOff;
  if (!segment.unknown && segment.end !== b.length) {
    errors.push(`定长 Segment 结束于 ${segment.end}，文件尾为 ${b.length}`);
  }

  let pos = segDataStart;
  let info = null;
  let tracks = null;
  const seekHeads = [];
  for (let i = 0; i < 30 && pos < b.length; i++) {
    const el = readElement(b, pos);
    if (!el) break;
    if (el.id === ID.SEEKHEAD) seekHeads.push(el);
    if (el.id === ID.INFO) info = el;
    if (el.id === ID.TRACKS) tracks = el;
    if (el.id === ID.CLUSTER || el.unknown || el.end <= pos) break;
    pos = el.end;
  }
  if (seekHeads.length !== 1) errors.push(`头部 SeekHead 数量=${seekHeads.length}，预期 1`);
  if (!info) errors.push('头部缺 Info');
  if (!tracks) errors.push('头部缺 Tracks');
  const cues = findCues(b);
  if (!cues) errors.push('文件尾缺 Cues');

  if (seekHeads.length === 1) {
    const entries = new Map();
    for (const seek of children(b, seekHeads[0].dataOff, seekHeads[0].end)) {
      if (seek.id !== ID.SEEK) continue;
      const cs = children(b, seek.dataOff, seek.end);
      const id = cs.find(x => x.id === ID.SEEKID);
      const position = cs.find(x => x.id === ID.SEEKPOS);
      if (!id || !position) continue;
      const targetId = uint(b, id.dataOff, id.end - id.dataOff);
      entries.set(targetId, uint(b, position.dataOff, position.end - position.dataOff));
    }
    for (const [targetId, el] of [[ID.INFO, info], [ID.TRACKS, tracks], [ID.CUES, cues]]) {
      if (!entries.has(targetId)) {
        errors.push(`SeekHead 缺 ${NAME[targetId]} 条目`);
      } else if (el && segDataStart + entries.get(targetId) !== el.off) {
        errors.push(`${NAME[targetId]} SeekPosition 指向 ${segDataStart + entries.get(targetId)}，实际 ${el.off}`);
      }
    }
  }

  const cueTimes = [];
  if (cues) {
    for (const cue of cueEntries(b, cues)) {
      cueTimes.push(cue.time);
      const target = readElement(b, segDataStart + cue.clusterPosition);
      if (!target || target.id !== ID.CLUSTER) {
        errors.push(`Cue(${cue.time}) 未命中 Cluster：${segDataStart + cue.clusterPosition}`);
      }
    }
    if (!cueTimes.length) errors.push('Cues 没有有效 CuePoint');
    for (let i = 1; i < cueTimes.length; i++) {
      if (cueTimes[i] < cueTimes[i - 1]) errors.push('CueTime 非单调');
    }
  }
  return { errors, cueTimes, segmentUnknown: segment.unknown, info };
}

export function webMClustersEqual(input, output) {
  function clusters(b) {
    const cues = findCues(b);
    const mediaEnd = cues ? cues.off : b.length;
    const signature = Buffer.from([0x1F, 0x43, 0xB6, 0x75]);
    const found = [];
    let at = 0;
    while ((at = b.indexOf(signature, at)) >= 0 && at < mediaEnd) {
      const el = readElement(b, at);
      if (el) {
        const timecode = readElement(b, el.dataOff);
        if (timecode && timecode.id === ID.TIMECODE && !timecode.unknown) {
          found.push({
            off: at,
            time: uint(b, timecode.dataOff, timecode.end - timecode.dataOff),
            el,
          });
        }
      }
      at++;
    }
    function nextCues(off) {
      const signature = Buffer.from([0x1C, 0x53, 0xBB, 0x6B]);
      let at = off;
      while ((at = b.indexOf(signature, at)) >= 0 && at < mediaEnd) {
        const el = readElement(b, at);
        if (el && !el.unknown && el.end <= mediaEnd) {
          const first = readElement(b, el.dataOff);
          if (first && first.id === ID.CUEPOINT) return at;
        }
        at++;
      }
      return mediaEnd;
    }
    return found.map((item, i) => {
      const nextCluster = found[i + 1]?.off ?? mediaEnd;
      const end = item.el.unknown ? Math.min(nextCluster, nextCues(item.off + 4)) : item.el.end;
      return { time: item.time, raw: b.subarray(item.off, end) };
    });
  }
  const a = clusters(input);
  const z = clusters(output);
  return a.length === z.length && a.every((item, i) =>
    item.time === z[i].time && item.raw.equals(z[i].raw));
}
