import { useState, useEffect, useRef } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import { io, Socket } from 'socket.io-client';
import VideoCall from './VideoCall';

function App() {
  const [user, setUser] = useState<any>(() => {
    const saved = localStorage.getItem('user');
    return saved ? JSON.parse(saved) : null;
  });
  const [token, setToken] = useState<string>(() => localStorage.getItem('token') || '');
  
  const [searchEmail, setSearchEmail] = useState('');
  const [searchResult, setSearchResult] = useState<any>(null);
  
  const [requests, setRequests] = useState<any[]>([]);
  const [friends, setFriends] = useState<any[]>([]);
  const friendsRef = useRef<any[]>([]);
  
  const [activeFriend, setActiveFriend] = useState<any>(null);
  const activeFriendRef = useRef<any>(null);

  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState('');
  
  const [onlineUsers, setOnlineUsers] = useState<string[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  
  const [isCalling, setIsCalling] = useState(false);
  const isCallingRef = useRef(false);
  const [incomingCall, setIncomingCall] = useState<any>(null);
  const [callOffer, setCallOffer] = useState<any>(null);

  useEffect(() => {
    isCallingRef.current = isCalling;
  }, [isCalling]);
  
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    activeFriendRef.current = activeFriend;
  }, [activeFriend]);

  useEffect(() => {
    friendsRef.current = friends;
  }, [friends]);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  const api = (path: string, options: any = {}) => {
    return fetch(`${import.meta.env.VITE_API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    }).then(res => res.json());
  };

  const handleLogin = async (res: any) => {
    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: res.credential }),
      });
      const data = await response.json();
      setUser(data.user);
      setToken(data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('token', data.token);
    } catch (err) {
      alert('Login failed');
    }
  };

  useEffect(() => {
    if (!token) return;

    api('/api/friends/requests').then(data => setRequests(data.requests || []));
    api('/api/friends').then(data => setFriends(data.friends || []));

    const newSocket = io(import.meta.env.VITE_API_URL, {
      auth: { token }
    });
    
    newSocket.on('receive_message', (msg) => {
      const currentFriend = activeFriendRef.current;
      
      if (currentFriend && (msg.senderId === currentFriend.id || msg.receiverId === currentFriend.id)) {
        setMessages(prev => [...prev, msg]);
      }
      
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      if (msg.senderId !== currentUser?.id && (!currentFriend || msg.senderId !== currentFriend.id)) {
        const sender = friendsRef.current.find(f => f.id === msg.senderId);
        setNotifications(prev => [...prev, {
          id: msg.id,
          senderId: msg.senderId,
          senderName: sender ? sender.name : 'Someone',
          content: msg.content
        }]);

        if ('Notification' in window && Notification.permission === 'granted') {
          const n = new Notification(`New message from ${sender ? sender.name : 'Someone'}`, {
            body: msg.content
          });
          n.onclick = () => {
            window.focus();
            if (sender) setActiveFriend(sender);
            setNotifications(prev => prev.filter(notif => notif.id !== msg.id));
            n.close();
          };
        }
      }
    });

    newSocket.on('friend_request', (req) => {
      setRequests(prev => [...prev, req]);
    });

    newSocket.on('friend_accepted', (friend) => {
      setFriends(prev => {
        if (prev.find(f => f.id === friend.id)) return prev;
        return [...prev, friend];
      });
    });

    newSocket.on('online_users', (users: string[]) => {
      setOnlineUsers(users);
    });

    newSocket.on('incoming_call', (data) => {
      if (isCallingRef.current && activeFriendRef.current && data.from === activeFriendRef.current.id) {
        // If we're ALREADY in a call, it's a re-negotiation
        setCallOffer(data.offer);
      } else {
        // If we're not in a call, it's a NEW incoming call
        setIncomingCall(data);
      }
    });

    setSocket(newSocket);

    return () => { newSocket.close(); };
  }, [token]);

  useEffect(() => {
    if (!activeFriend) return;
    api(`/api/messages/${activeFriend.id}`).then(data => setMessages(data.messages || []));
  }, [activeFriend]);

  const searchUser = async () => {
    const data = await api(`/api/users/search?email=${searchEmail}`);
    if (data.user) setSearchResult(data.user);
    else alert('User not found');
  };

  const sendRequest = async () => {
    if (!searchResult) return;
    const res = await api('/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ receiverId: searchResult.id })
    });
    if (res.error) alert(res.error);
    else {
      alert('Request sent');
      setSearchResult(null);
      setSearchEmail('');
    }
  };

  const acceptRequest = async (id: string) => {
    await api('/api/friends/accept', {
      method: 'POST',
      body: JSON.stringify({ requestId: id })
    });
    api('/api/friends/requests').then(data => setRequests(data.requests || []));
    api('/api/friends').then(data => setFriends(data.friends || []));
  };

  const sendMessage = () => {
    if (!socket || !newMessage || !activeFriend) return;
    socket.emit('send_message', {
      receiverId: activeFriend.id,
      content: newMessage
    });
    setNewMessage('');
  };

  const handleNotificationClick = (notif: any) => {
    const friend = friends.find(f => f.id === notif.senderId);
    if (friend) {
      setActiveFriend(friend);
    }
    setNotifications(prev => prev.filter(n => n.id !== notif.id));
  };

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-100 flex flex-col items-center gap-6 max-w-sm w-full">
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-gray-900">Welcome</h1>
            <p className="text-sm text-gray-500 mt-1">Sign in to start chatting</p>
          </div>
          <GoogleLogin onSuccess={handleLogin} onError={() => alert('Error')} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-50 flex justify-center p-4 md:p-8 relative overflow-hidden">
      {/* Toast Notifications */}
      <div className="absolute bottom-6 right-6 flex flex-col gap-3 z-50">
        {notifications.map(notif => (
          <div 
            key={notif.id} 
            className="bg-white border border-gray-200 shadow-lg rounded-xl p-4 w-72 cursor-pointer hover:shadow-xl transition-shadow flex flex-col gap-1 relative overflow-hidden"
            onClick={() => handleNotificationClick(notif)}
          >
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-500"></div>
            <div className="flex justify-between items-center pl-2">
              <span className="font-semibold text-gray-900 text-sm">New message from {notif.senderName}</span>
              <button 
                className="text-gray-400 hover:text-gray-600 p-1"
                onClick={(e) => {
                  e.stopPropagation();
                  setNotifications(prev => prev.filter(n => n.id !== notif.id));
                }}
              >
                &times;
              </button>
            </div>
            <p className="text-sm text-gray-500 truncate pl-2">{notif.content}</p>
          </div>
        ))}
      </div>

      <div className="max-w-6xl w-full h-full bg-white rounded-2xl shadow-sm border border-gray-100 flex flex-col overflow-hidden">
        
        {/* Header */}
        <header className="border-b border-gray-100 p-4 flex justify-between items-center bg-white z-10">
          <div className="flex items-center gap-4 cursor-pointer" onClick={() => setActiveFriend(null)}>
            <img src={user.avatarUrl} alt="Avatar" className="w-10 h-10 rounded-full bg-gray-100 ring-2 ring-white shadow-sm" />
            <div>
              <h1 className="font-semibold text-gray-900 leading-tight">Dashboard</h1>
              <p className="text-xs text-gray-500">{user.email}</p>
            </div>
          </div>
          <button 
            className="text-sm px-4 py-2 text-gray-600 hover:bg-gray-50 rounded-lg transition-colors font-medium"
            onClick={() => { 
              setUser(null); 
              setToken(''); 
              localStorage.removeItem('user');
              localStorage.removeItem('token');
            }}
          >
            Sign out
          </button>
        </header>

        {/* Main Content */}
        <div className="flex flex-1 overflow-hidden">
          
          {/* Sidebar */}
          <div className="w-80 border-r border-gray-100 flex flex-col bg-gray-50/50">
            
            {/* Search */}
            <div className="p-4 border-b border-gray-100">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Add Friend</h3>
              <div className="flex gap-2">
                <input 
                  className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all bg-white shadow-sm"
                  placeholder="friend@email.com" 
                  value={searchEmail} 
                  onChange={e => setSearchEmail(e.target.value)} 
                  onKeyDown={e => e.key === 'Enter' && searchUser()}
                />
                <button 
                  className="px-3 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-800 transition-colors font-medium shadow-sm"
                  onClick={searchUser}
                >
                  Find
                </button>
              </div>
              
              {searchResult && (
                <div className="mt-3 p-3 bg-white border border-gray-100 rounded-lg flex items-center justify-between shadow-sm animate-in fade-in slide-in-from-top-2">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-gray-900">{searchResult.name}</span>
                    <span className="text-xs text-gray-500 truncate w-32">{searchResult.email}</span>
                  </div>
                  <button 
                    className="text-xs px-3 py-1.5 bg-gray-900 text-white hover:bg-gray-800 font-medium rounded-md transition-colors"
                    onClick={sendRequest}
                  >
                    Add
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              <div className="p-4">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Your Friends</h3>
                {friends.length === 0 ? (
                  <p className="text-sm text-gray-500 italic">No friends yet. Search an email to add someone!</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {friends.map(friend => {
                      const isOnline = onlineUsers.includes(friend.id);
                      return (
                        <button 
                          key={friend.id}
                          className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all flex items-center justify-between ${
                            activeFriend?.id === friend.id 
                              ? 'bg-white shadow-sm font-medium text-gray-900 ring-1 ring-gray-200' 
                              : 'text-gray-600 hover:bg-gray-100 border-transparent'
                          } ${isOnline && activeFriend?.id !== friend.id ? 'border-l-4 border-green-500 bg-green-50/30' : ''}`}
                          onClick={() => setActiveFriend(friend)}
                        >
                          <span className="truncate pr-2">{friend.name}</span>
                          {isOnline && <span className="w-2 h-2 rounded-full bg-green-500 shrink-0 shadow-sm"></span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Chat Area / Dashboard View */}
          <div className="flex-1 flex flex-col bg-white">
            {activeFriend ? (
              <>
                {/* Chat Header */}
                <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-white">
                  <div className="flex items-center gap-3">
                    <div>
                      <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                        {activeFriend.name}
                        {onlineUsers.includes(activeFriend.id) && <span className="w-2 h-2 rounded-full bg-green-500"></span>}
                      </h2>
                      <p className="text-xs text-gray-500">{activeFriend.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button 
                      onClick={() => setIsCalling(true)}
                      className="text-xs px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium shadow-sm flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Video Call
                    </button>
                    <button 
                      onClick={() => setActiveFriend(null)}
                      className="text-xs px-3 py-1.5 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors font-medium"
                    >
                      Back to Dashboard
                    </button>
                  </div>
                </div>

                {/* Messages */}
                <div className="flex-1 p-6 overflow-y-auto flex flex-col gap-4 bg-gray-50/30">
                  {messages.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-gray-400 text-sm">
                      <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mb-3">👋</div>
                      No messages yet. Say hi!
                    </div>
                  ) : (
                    messages.map((m, i) => {
                      const isMe = m.senderId === user.id;
                      return (
                        <div key={i} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[70%] rounded-2xl px-4 py-2.5 shadow-sm text-sm ${
                            isMe 
                              ? 'bg-gray-900 text-white rounded-br-none' 
                              : 'bg-white border border-gray-100 text-gray-900 rounded-bl-none'
                          }`}>
                            {m.content}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Input */}
                <div className="p-4 bg-white border-t border-gray-100">
                  <div className="flex gap-2">
                    <input 
                      className="flex-1 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-gray-400"
                      value={newMessage} 
                      onChange={e => setNewMessage(e.target.value)} 
                      placeholder="Type your message..."
                      onKeyDown={e => e.key === 'Enter' && sendMessage()}
                    />
                    <button 
                      className="px-6 py-3 bg-gray-900 text-white font-medium rounded-xl hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                      onClick={sendMessage}
                      disabled={!newMessage.trim()}
                    >
                      Send
                    </button>
                  </div>
                </div>
              </>
            ) : (
              // Dashboard Overview
              <div className="flex-1 flex flex-col p-8 overflow-y-auto bg-gray-50/30">
                <h2 className="text-2xl font-semibold text-gray-900 mb-2">Welcome back, {user.name.split(' ')[0]}</h2>
                <p className="text-gray-500 text-sm mb-8">Here's what's happening today.</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Requests Card */}
                  <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm flex flex-col">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-gray-900">Pending Requests</h3>
                      <span className="bg-gray-100 text-gray-600 px-2.5 py-0.5 rounded-full text-xs font-medium">{requests.length}</span>
                    </div>
                    {requests.length === 0 ? (
                      <p className="text-sm text-gray-500 italic mt-auto">You're all caught up!</p>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {requests.map(req => (
                          <div key={req.id} className="flex items-center justify-between p-3 bg-gray-50 border border-gray-100 rounded-xl">
                            <span className="text-sm text-gray-900 font-medium truncate pr-2">{req.sender.name}</span>
                            <button 
                              className="text-xs px-4 py-2 bg-gray-900 text-white font-medium rounded-lg hover:bg-gray-800 transition-colors shadow-sm"
                              onClick={() => acceptRequest(req.id)}
                            >
                              Accept
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Stats Card */}
                  <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm flex flex-col">
                    <h3 className="font-semibold text-gray-900 mb-4">Network Overview</h3>
                    <div className="flex flex-col gap-4 mt-auto">
                      <div className="flex justify-between items-center p-3 bg-gray-50 rounded-xl border border-gray-100">
                        <span className="text-sm text-gray-600">Total Friends</span>
                        <span className="text-lg font-semibold text-gray-900">{friends.length}</span>
                      </div>
                      <div className="flex justify-between items-center p-3 bg-green-50/50 rounded-xl border border-green-100">
                        <span className="text-sm text-green-700">Online Now</span>
                        <span className="text-lg font-semibold text-green-700">{onlineUsers.length-1}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {incomingCall && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white p-8 rounded-2xl shadow-2xl max-w-sm w-full text-center">
            <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
              <svg className="w-10 h-10 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-gray-900 mb-1">Incoming Call</h3>
            <p className="text-gray-500 text-sm mb-6">{friends.find(f => f.id === incomingCall.from)?.name || 'Someone'} is calling you...</p>
            <div className="flex gap-4">
              <button 
                onClick={() => {
                  setIncomingCall(null);
                  socket?.emit('end_call', { to: incomingCall.from });
                }}
                className="flex-1 py-3 bg-gray-100 text-gray-600 font-semibold rounded-xl hover:bg-gray-200 transition-colors"
              >
                Decline
              </button>
              <button 
                onClick={() => {
                  const friend = friendsRef.current.find(f => f.id === incomingCall.from);
                  if (friend) {
                    setCallOffer(incomingCall.offer);
                    setActiveFriend(friend);
                    setIsCalling(true);
                  }
                  setIncomingCall(null);
                }}
                className="flex-1 py-3 bg-blue-600 text-white font-semibold rounded-xl hover:bg-blue-700 transition-colors"
              >
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {isCalling && socket && activeFriend && (
        <VideoCall 
          socket={socket} 
          activeFriend={activeFriend} 
          user={user} 
          onClose={() => {
            setIsCalling(false);
            setCallOffer(null);
            setIncomingCall(null);
          }} 
          incomingOffer={callOffer}
        />
      )}
    </div>
  );
}

export default App;
