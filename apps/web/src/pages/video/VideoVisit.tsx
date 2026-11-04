import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import {
  endVideo,
  joinVideo,
  videoInfo,
  type JoinResult,
  type VideoInfo,
} from '../../api/telemedicine';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorAlert,
  Loading,
  PageHeader,
  SelectField,
} from '../../components/ui';
import { formatDateTime } from '../../format';
import { t } from '../../i18n';
import { useVideoCall, type CallState } from './useVideoCall';
import './video.css';

type Phase = 'check' | 'call' | 'ended';

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((tr) => tr.stop());
}

function mediaErrorText(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return t(
      'Camera and microphone access was blocked. Allow it in the browser (the camera icon in the address bar) and try again.',
    );
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return t('No camera or microphone was found. Connect one, or join with audio only.');
  if (name === 'NotReadableError')
    return t('The camera or microphone is used by another application. Close it and try again.');
  return t('Your camera or microphone could not be started.');
}

/** Pre-call check: choose camera and microphone, see yourself, then join. */
function DeviceCheck({
  info,
  onJoin,
  joining,
  joinError,
}: {
  info: VideoInfo;
  onJoin: (stream: MediaStream) => void;
  joining: boolean;
  joinError: unknown;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [audioOnly, setAudioOnly] = useState(false);
  const preview = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        t(
          'This browser does not support video calls. Use a current Chrome, Edge, Firefox or Safari.',
        ),
      );
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        video: audioOnly ? false : cameraId ? { deviceId: { exact: cameraId } } : true,
        audio: micId ? { deviceId: { exact: micId } } : true,
      })
      .then(async (s) => {
        if (cancelled) {
          stopStream(s);
          return;
        }
        stopStream(streamRef.current);
        streamRef.current = s;
        setStream(s);
        setError(null);
        setDevices(await navigator.mediaDevices.enumerateDevices());
      })
      .catch((err: unknown) => !cancelled && setError(mediaErrorText(err)));
    return () => {
      cancelled = true;
    };
  }, [cameraId, micId, audioOnly]);

  useEffect(() => {
    if (preview.current) preview.current.srcObject = stream;
  }, [stream]);

  // Stop the preview if the user leaves without joining.
  useEffect(() => () => undefined, []);

  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');

  return (
    <Card title={t('Check your camera and microphone')}>
      <div className="stack">
        {!info.window.open && (
          <Alert tone="info" title={t('The video visit opens 15 minutes before the appointment')}>
            {t('You can check your devices now. The room opens at {time}.', {
              time: formatDateTime(info.window.opensAt),
            })}
          </Alert>
        )}
        {error && <Alert tone="warning">{error}</Alert>}
        {!audioOnly && (
          <video
            ref={preview}
            className="video-preview"
            autoPlay
            playsInline
            muted
            aria-label={t('Your camera preview')}
          />
        )}
        <div className="form-grid">
          {cameras.length > 0 && !audioOnly && (
            <SelectField
              label={t('Camera')}
              value={cameraId || stream?.getVideoTracks()[0]?.getSettings().deviceId || ''}
              onChange={(e) => setCameraId(e.target.value)}
              options={cameras.map((d, i) => ({
                value: d.deviceId,
                label: d.label || t('Camera {n}', { n: i + 1 }),
              }))}
            />
          )}
          {mics.length > 0 && (
            <SelectField
              label={t('Microphone')}
              value={micId || stream?.getAudioTracks()[0]?.getSettings().deviceId || ''}
              onChange={(e) => setMicId(e.target.value)}
              options={mics.map((d, i) => ({
                value: d.deviceId,
                label: d.label || t('Microphone {n}', { n: i + 1 }),
              }))}
            />
          )}
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={audioOnly}
            onChange={(e) => setAudioOnly(e.target.checked)}
          />
          <span>{t('Join with audio only')}</span>
        </label>
        <p className="muted" style={{ margin: 0 }}>
          {t(
            'The call goes directly between your device and the other participant’s. It is not recorded.',
          )}
        </p>
        <ErrorAlert error={joinError} />
        <div className="form-actions">
          <Button
            disabled={!stream || !info.window.open}
            loading={joining}
            onClick={() => stream && onJoin(stream)}
          >
            {info.side === 'doctor' ? t('Start video visit') : t('Join video visit')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

const STATE_TEXT = (s: CallState, side: 'doctor' | 'patient', peerPresent: boolean) => {
  switch (s) {
    case 'waiting':
      return peerPresent
        ? t('Connecting…')
        : side === 'patient'
          ? t('You are in the waiting room. The doctor will join shortly.')
          : t('Waiting for the patient to join…');
    case 'connecting':
      return t('Connecting…');
    case 'reconnecting':
      return t('Connection lost – reconnecting…');
    case 'connected':
      return t('Connected');
    case 'ended':
      return t('The video visit has ended');
  }
};

/** The call itself: remote video large, own preview small, controls at the bottom. */
function Call({
  info,
  joined,
  stream,
  onEnded,
}: {
  info: VideoInfo;
  joined: JoinResult;
  stream: MediaStream;
  onEnded: (chartPath?: string, byPeer?: boolean) => void;
}) {
  const remote = useRef<HTMLVideoElement>(null);
  const local = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [localStream, setLocalStream] = useState(stream);
  const [ending, setEnding] = useState(false);
  const onPeerEnded = useCallback(() => onEnded(undefined, true), [onEnded]);
  const call = useVideoCall({
    sessionId: joined.sessionId,
    side: joined.role,
    iceServers: joined.iceServers,
    localStream: stream,
    onPeerEnded,
  });

  useEffect(() => {
    if (remote.current) remote.current.srcObject = call.remoteStream;
  }, [call.remoteStream]);
  useEffect(() => {
    if (local.current) local.current.srcObject = localStream;
  }, [localStream]);

  const hasVideo = stream.getVideoTracks().length > 0;
  const toggleMute = () => {
    const next = !muted;
    stream.getAudioTracks().forEach((tr) => (tr.enabled = !next));
    setMuted(next);
  };
  const toggleCamera = () => {
    const next = !cameraOff;
    stream.getVideoTracks().forEach((tr) => (tr.enabled = !next));
    setCameraOff(next);
  };
  const switchCamera = async () => {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'videoinput',
    );
    if (cams.length < 2) return;
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    const idx = cams.findIndex((c) => c.deviceId === current);
    const next = cams[(idx + 1) % cams.length]!;
    const s = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: next.deviceId } },
    });
    const track = s.getVideoTracks()[0]!;
    await call.replaceVideoTrack(track);
    const old = stream.getVideoTracks()[0];
    if (old) {
      stream.removeTrack(old);
      old.stop();
    }
    stream.addTrack(track);
    track.enabled = !cameraOff;
    setLocalStream(new MediaStream(stream.getTracks()));
  };
  const end = async () => {
    setEnding(true);
    try {
      const r = await endVideo(joined.sessionId);
      call.stop();
      onEnded(r.chartPath);
    } finally {
      setEnding(false);
    }
  };

  const connected = call.state === 'connected';
  return (
    <div className="stack">
      <div className="video-stage">
        <video
          ref={remote}
          className="video-remote"
          autoPlay
          playsInline
          aria-label={
            info.side === 'doctor'
              ? t('Video of {name}', { name: info.appointment.patientName })
              : t('Video of {name}', { name: info.appointment.doctorName })
          }
        />
        {!connected && (
          <div className="video-overlay" role="status">
            <p>{STATE_TEXT(call.state, info.side, call.peerPresent)}</p>
          </div>
        )}
        <span className="video-status">
          <Badge tone={connected ? 'success' : call.state === 'reconnecting' ? 'warning' : 'info'}>
            {STATE_TEXT(call.state, info.side, call.peerPresent)}
          </Badge>
        </span>
        {hasVideo && (
          <video
            ref={local}
            className="video-local"
            autoPlay
            playsInline
            muted
            aria-label={t('Your camera preview')}
          />
        )}
        <div className="video-controls">
          <Button variant="secondary" size="sm" onClick={toggleMute} aria-pressed={muted}>
            {muted ? t('Unmute') : t('Mute')}
          </Button>
          {hasVideo && (
            <Button variant="secondary" size="sm" onClick={toggleCamera} aria-pressed={cameraOff}>
              {cameraOff ? t('Turn camera on') : t('Turn camera off')}
            </Button>
          )}
          {hasVideo && (
            <Button variant="secondary" size="sm" onClick={() => void switchCamera()}>
              {t('Switch camera')}
            </Button>
          )}
          <Button variant="danger" size="sm" loading={ending} onClick={() => void end()}>
            {t('End visit')}
          </Button>
        </div>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t(
          'The call goes directly between your device and the other participant’s. It is not recorded.',
        )}
      </p>
    </div>
  );
}

export function VideoVisit() {
  const { appointmentId = '' } = useParams();
  const user = useUser();
  const [phase, setPhase] = useState<Phase>('check');
  const [joined, setJoined] = useState<JoinResult | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<unknown>(null);
  const [endInfo, setEndInfo] = useState<{ chartPath?: string; byPeer?: boolean }>({});
  const info = useQuery({
    queryKey: ['video', appointmentId, 'info'],
    queryFn: () => videoInfo(appointmentId),
    refetchInterval: (q) => (q.state.data && !q.state.data.window.open ? 30_000 : false),
  });

  // Release the camera when leaving the page.
  const streamRef = useRef<MediaStream | null>(null);
  streamRef.current = stream;
  useEffect(() => () => stopStream(streamRef.current), []);

  const onJoin = async (s: MediaStream) => {
    setJoining(true);
    setJoinError(null);
    try {
      const r = await joinVideo(appointmentId);
      setStream(s);
      setJoined(r);
      setPhase('call');
    } catch (err) {
      setJoinError(err);
    } finally {
      setJoining(false);
    }
  };

  const onEnded = useCallback((chartPath?: string, byPeer?: boolean) => {
    stopStream(streamRef.current);
    setEndInfo({ chartPath, byPeer });
    setPhase('ended');
  }, []);

  if (info.isPending) return <Loading label={t('Loading video visit…')} />;
  if (info.error) {
    return (
      <Card title={t('Video visit unavailable')}>
        <ErrorAlert error={info.error} />
        {info.error instanceof ApiError && info.error.status === 403 && (
          <p>{t('Only the doctor and the patient of this appointment can join.')}</p>
        )}
      </Card>
    );
  }
  const i = info.data;
  const backPath = user.role === 'DOCTOR' ? '/doctor/schedule' : '/portal/appointments';
  const other = i.side === 'doctor' ? i.appointment.patientName : i.appointment.doctorName;

  return (
    <>
      <PageHeader
        title={t('Video visit')}
        subtitle={t('{name} · {time}', {
          name: other,
          time: formatDateTime(i.appointment.scheduledAt),
        })}
        actions={
          <Link to={backPath} className="btn btn-secondary btn-sm">
            {i.side === 'doctor' ? t('Back to schedule') : t('Back to appointments')}
          </Link>
        }
      />
      {i.appointment.mode !== 'VIDEO' ? (
        <Alert tone="info">{t('This appointment is an in-person visit.')}</Alert>
      ) : i.session?.status === 'ENDED' && phase !== 'ended' ? (
        <Alert tone="info" title={t('The video visit has ended')} />
      ) : phase === 'check' ? (
        <DeviceCheck
          info={i}
          onJoin={(s) => void onJoin(s)}
          joining={joining}
          joinError={joinError}
        />
      ) : phase === 'call' && joined && stream ? (
        <Call info={i} joined={joined} stream={stream} onEnded={onEnded} />
      ) : (
        <Card title={t('The video visit has ended')}>
          <div className="stack">
            {endInfo.byPeer && (
              <p>
                {i.side === 'doctor'
                  ? t('The patient ended the visit.')
                  : t('The doctor ended the visit.')}
              </p>
            )}
            {i.side === 'doctor' && i.appointment.patientId ? (
              <p>
                <Link
                  className="btn btn-primary btn-md"
                  to={endInfo.chartPath ?? `/doctor/patients/${i.appointment.patientId}?tab=visits`}
                >
                  {t('Open the chart to document the visit')}
                </Link>
              </p>
            ) : (
              <p>{t('Thank you. Any follow-up from your doctor will appear in your portal.')}</p>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
