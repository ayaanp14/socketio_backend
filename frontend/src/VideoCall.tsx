import { useEffect, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';

interface VideoCallProps {
  socket: Socket;
  activeFriend: any;
  user: any;
  onClose: () => void;
  incomingOffer?: any;
}

export default function VideoCall({ socket, activeFriend, user, onClose, incomingOffer }: VideoCallProps) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const servers = {
    iceServers: [
      {
        urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'],
      },
    ],
  };

  useEffect(() => {
    console.log('VideoCall mounted', { activeFriend, incomingOffer: !!incomingOffer });

    socket.on('call_answered', async (data) => {
      console.log('Call answered received');
      await peerConnection.current?.setRemoteDescription(new RTCSessionDescription(data.answer));
    });

    socket.on('ice_candidate', async (data) => {
      console.log('Remote ICE candidate received');
      if (data.candidate) {
        await peerConnection.current?.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    });

    socket.on('call_ended', () => {
      console.log('Call ended by remote');
      handleEndCall();
    });

    const startCall = async () => {
      let stream: MediaStream | null = null;
      try {
        console.log('Attempting to capture media...');
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        console.log('Camera and Microphone captured');
      } catch (err) {
        console.warn('Could not capture camera/mic, trying audio only...', err);
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          console.log('Microphone only captured');
        } catch (audioErr) {
          console.error('No media devices available:', audioErr);
        }
      }

      if (stream) {
        setLocalStream(stream);
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      }

      peerConnection.current = new RTCPeerConnection(servers);

      if (stream) {
        stream.getTracks().forEach((track) => {
          peerConnection.current?.addTrack(track, stream!);
        });
      }

      peerConnection.current.ontrack = (event) => {
        console.log('Remote track received');
        setRemoteStream(event.streams[0]);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = event.streams[0];
      };

      peerConnection.current.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Sending local ICE candidate');
          socket.emit('ice_candidate', { to: activeFriend.id, candidate: event.candidate });
        }
      };

      peerConnection.current.onnegotiationneeded = async () => {
        try {
          console.log('Negotiation needed, creating re-offer...');
          const offer = await peerConnection.current?.createOffer();
          await peerConnection.current?.setLocalDescription(offer);
          socket.emit('call_user', { to: activeFriend.id, offer });
        } catch (err) {
          console.error('Negotiation failed:', err);
        }
      };

      if (incomingOffer) {
        console.log('Handling incoming offer...');
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(incomingOffer));
        const answer = await peerConnection.current.createAnswer();
        await peerConnection.current.setLocalDescription(answer);
        socket.emit('answer_call', { to: activeFriend.id, answer });
      } else {
        console.log('Creating outgoing offer...');
        const offer = await peerConnection.current.createOffer();
        await peerConnection.current.setLocalDescription(offer);
        socket.emit('call_user', { to: activeFriend.id, offer });
      }
    };

    startCall();

    return () => {
      console.log('VideoCall unmounting');
      socket.off('call_answered');
      socket.off('ice_candidate');
      socket.off('call_ended');
      localStream?.getTracks().forEach(track => track.stop());
    };
  }, []);

  useEffect(() => {
    if (incomingOffer && peerConnection.current) {
      console.log('New offer received during call (negotiation)', peerConnection.current.signalingState);
      const handleNegotiation = async () => {
        try {
          // If we are already handling an offer, wait or ignore? 
          // For simplicity, we'll just process it if not closed.
          if (peerConnection.current?.signalingState === 'closed') return;
          
          await peerConnection.current?.setRemoteDescription(new RTCSessionDescription(incomingOffer));
          const answer = await peerConnection.current?.createAnswer();
          await peerConnection.current?.setLocalDescription(answer);
          socket.emit('answer_call', { to: activeFriend.id, answer });
        } catch (err) {
          console.error('Negotiation handling failed:', err);
        }
      };
      handleNegotiation();
    }
  }, [incomingOffer, activeFriend.id, socket]);

  useEffect(() => {
    if (remoteStream && remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  useEffect(() => {
    if (localStream && localVideoRef.current && !isScreenSharing) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, isScreenSharing]);

  const handleEndCall = () => {
    socket.emit('end_call', { to: activeFriend.id });
    localStream?.getTracks().forEach(track => track.stop());
    peerConnection.current?.close();
    onClose();
  };

  const toggleScreenShare = async () => {
    try {
      if (!isScreenSharing) {
        console.log('Requesting screen share...');
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const videoTrack = screenStream.getVideoTracks()[0];
        
        const sender = peerConnection.current?.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          console.log('Replacing existing video track with screen track');
          sender.replaceTrack(videoTrack);
        } else {
          console.log('Adding new screen track to peer connection');
          peerConnection.current?.addTrack(videoTrack, screenStream);
        }

        if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;
        
        videoTrack.onended = () => {
          stopScreenShare();
        };
        
        setIsScreenSharing(true);
      } else {
        stopScreenShare();
      }
    } catch (err) {
      console.error('Screen share failed:', err);
    }
  };

  const stopScreenShare = async () => {
    const videoTrack = localStream?.getVideoTracks()[0];
    const sender = peerConnection.current?.getSenders().find(s => s.track?.kind === 'video');
    if (sender && videoTrack) sender.replaceTrack(videoTrack);
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
    setIsScreenSharing(false);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/90 flex flex-col items-center justify-center p-4">
      <div className="relative w-full max-w-4xl aspect-video bg-gray-900 rounded-2xl overflow-hidden shadow-2xl border border-gray-800">
        <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
        <video 
          ref={localVideoRef} 
          autoPlay 
          playsInline 
          muted 
          className="absolute bottom-4 right-4 w-48 aspect-video bg-black rounded-lg border border-gray-700 object-cover" 
        />
        
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-gray-800/80 backdrop-blur-md px-6 py-3 rounded-full border border-gray-700">
          <button 
            onClick={toggleScreenShare}
            className={`p-3 rounded-full transition-colors ${isScreenSharing ? 'bg-blue-500 text-white' : 'bg-gray-700 text-gray-200 hover:bg-gray-600'}`}
          >
            {isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
          </button>
          <button 
            onClick={handleEndCall}
            className="p-3 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors px-6 font-semibold"
          >
            End Call
          </button>
        </div>

        <div className="absolute top-4 left-4 text-white">
          <p className="font-semibold">{activeFriend.name}</p>
          <p className="text-xs text-gray-400">Video Call</p>
        </div>
      </div>
    </div>
  );
}
