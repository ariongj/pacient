import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSignals, sendSignal, type Side, type SignalMessage } from '../../api/telemedicine';

export type CallState = 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'ended';

interface Options {
  sessionId: string;
  side: Side;
  iceServers: RTCIceServer[];
  localStream: MediaStream;
  onPeerEnded: () => void;
}

/**
 * 1:1 WebRTC call with signalling through the Pacient API.
 *
 * Protocol: each side sends `ready` after joining. The doctor answers every `ready` with a fresh
 * offer on a new connection ("generation"); the patient answers the doctor's `ready` with its own
 * `ready` (so a patient who joined first is not missed) and answers offers. ICE failures trigger a
 * new offer (doctor) or a new `ready` (patient). Messages are fetched on live events and polled
 * every 2 s as a fallback; `after` acknowledges processed messages so none is handled twice.
 */
export function useVideoCall({ sessionId, side, iceServers, localStream, onPeerEnded }: Options) {
  const [state, setState] = useState<CallState>('waiting');
  const [peerPresent, setPeerPresent] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const generation = useRef(0);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);
  const lastId = useRef(0);
  const lastOfferAt = useRef(0);
  const busy = useRef(false);
  const again = useRef(false);
  const stopped = useRef(false);
  const onPeerEndedRef = useRef(onPeerEnded);
  onPeerEndedRef.current = onPeerEnded;

  const signal = useCallback(
    (kind: Parameters<typeof sendSignal>[1], payload?: unknown) =>
      sendSignal(sessionId, kind, payload).catch(() => undefined),
    [sessionId],
  );

  const newConnection = useCallback(
    (gen: number) => {
      pc.current?.close();
      pendingCandidates.current = [];
      const conn = new RTCPeerConnection({ iceServers });
      for (const track of localStream.getTracks()) conn.addTrack(track, localStream);
      conn.ontrack = (e) => {
        const [stream] = e.streams;
        setRemoteStream(stream ?? new MediaStream([e.track]));
      };
      conn.onicecandidate = (e) => {
        if (e.candidate) void signal('candidate', { gen, candidate: e.candidate.toJSON() });
      };
      conn.onconnectionstatechange = () => {
        if (pc.current !== conn || stopped.current) return;
        const s = conn.connectionState;
        if (s === 'connected') setState('connected');
        else if (s === 'connecting' || s === 'new') setState('connecting');
        else if (s === 'disconnected') setState('reconnecting');
        else if (s === 'failed') {
          setState('reconnecting');
          if (side === 'doctor') void offer();
          else void signal('ready');
        }
      };
      pc.current = conn;
      generation.current = gen;
      return conn;
    },
    // offer is defined below and stable for the lifetime of the hook
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [iceServers, localStream, side, signal],
  );

  const offer = useCallback(async () => {
    lastOfferAt.current = Date.now();
    const gen = generation.current + 1;
    const conn = newConnection(gen);
    setState('connecting');
    const desc = await conn.createOffer();
    await conn.setLocalDescription(desc);
    await signal('offer', { gen, sdp: conn.localDescription?.toJSON() });
  }, [newConnection, signal]);

  const flushCandidates = useCallback(async () => {
    const conn = pc.current;
    if (!conn?.remoteDescription) return;
    for (const c of pendingCandidates.current.splice(0)) {
      await conn.addIceCandidate(c).catch(() => undefined);
    }
  }, []);

  const handle = useCallback(
    async (m: SignalMessage) => {
      const p = (m.payload ?? {}) as {
        gen?: number;
        sdp?: RTCSessionDescriptionInit;
        candidate?: RTCIceCandidateInit;
      };
      switch (m.kind) {
        case 'ready':
          setPeerPresent(true);
          if (side === 'doctor') {
            // Both sides' "ready" can arrive together; one fresh offer is enough.
            const recent = Date.now() - lastOfferAt.current < 4000;
            if (!(recent && pc.current && pc.current.connectionState !== 'failed')) await offer();
          } else await signal('ready');
          break;
        case 'offer': {
          if (side !== 'patient' || !p.sdp || p.gen === undefined) return;
          setPeerPresent(true);
          const conn =
            pc.current && generation.current === p.gen ? pc.current : newConnection(p.gen);
          setState('connecting');
          await conn.setRemoteDescription(p.sdp);
          await flushCandidates();
          const answer = await conn.createAnswer();
          await conn.setLocalDescription(answer);
          await signal('answer', { gen: p.gen, sdp: conn.localDescription?.toJSON() });
          break;
        }
        case 'answer':
          if (side !== 'doctor' || !p.sdp || p.gen !== generation.current || !pc.current) return;
          if (pc.current.signalingState !== 'have-local-offer') return;
          await pc.current.setRemoteDescription(p.sdp);
          await flushCandidates();
          break;
        case 'candidate':
          if (!p.candidate || p.gen !== generation.current || !pc.current) return;
          if (pc.current.remoteDescription) {
            await pc.current.addIceCandidate(p.candidate).catch(() => undefined);
          } else pendingCandidates.current.push(p.candidate);
          break;
        case 'bye':
          stopped.current = true;
          pc.current?.close();
          setState('ended');
          onPeerEndedRef.current();
          break;
      }
    },
    [flushCandidates, newConnection, offer, side, signal],
  );

  const pull = useCallback(async () => {
    if (stopped.current) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        const r = await fetchSignals(sessionId, lastId.current);
        setPeerPresent((was) => r.peerPresent || was);
        for (const m of r.items) {
          lastId.current = Math.max(lastId.current, m.id);
          await handle(m).catch(() => undefined);
        }
        if (r.status === 'ENDED' && !stopped.current) {
          stopped.current = true;
          pc.current?.close();
          setState('ended');
          onPeerEndedRef.current();
        }
      } while (again.current && !stopped.current);
    } catch {
      /* network hiccup – the next poll retries */
    } finally {
      busy.current = false;
    }
  }, [handle, sessionId]);

  useEffect(() => {
    stopped.current = false;
    void signal('ready').then(() => pull());
    const onEvent = (e: Event) => {
      if ((e as CustomEvent<{ ref?: string }>).detail?.ref === sessionId) void pull();
    };
    window.addEventListener('pacient:video-signal', onEvent);
    const timer = setInterval(() => void pull(), 2000);
    return () => {
      stopped.current = true;
      window.removeEventListener('pacient:video-signal', onEvent);
      clearInterval(timer);
      pc.current?.close();
      pc.current = null;
    };
  }, [pull, sessionId, signal]);

  /** Replace the outgoing video (camera switch) without renegotiating. */
  const replaceVideoTrack = useCallback(async (track: MediaStreamTrack) => {
    const sender = pc.current?.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(track);
  }, []);

  const stop = useCallback(() => {
    stopped.current = true;
    pc.current?.close();
    setState('ended');
  }, []);

  return { state, peerPresent, remoteStream, replaceVideoTrack, stop };
}
