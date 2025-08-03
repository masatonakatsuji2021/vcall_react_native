import { RTCPeerConnection, MediaStream, RTCSessionDescription } from "react-native-webrtc";

export interface VCallRemoteConnectOption {

    /**
     * Connection Room ID
     */
    roomId: string,

    /**
     * Identifier
     */
    identifier?: string,

    /**
     * Signaling Server URL
     */
    signalingUrl: string,
    
    /**
     * RTCPeerConnectionCOnfig
     */
    RTCPeerConnectionConfig: RTCConfiguration,

    /**
     * Local MediaStream
     */
    localStream?: MediaStream,
}

export interface VCallRemote {

    connectionId: string,

    identifier?: string,

    status: VcallRemoteStatus,

    peerConnection: RTCPeerConnection,

    iceCandidateBuffer: Array<RTCIceCandidate>,

    stream?: MediaStream,
}

export interface VCallRecord {

    identifier: string,

    record: MediaRecorder,

    buffer: Array<Blob>,
}

enum VcallRemoteStatus {
    Begin,
    Offer,
    Answer,
    Connected,
}

enum VCallHandleType {
    Open,
    Message,
    Close,
    RemoteOpen,
    RemoteClosed,
    Error,
    RecordStart,
    RecordData,
    RecordStopped,
    RecordError,
    REcordResume,
    RemoteVideoChangeStatus,
    RemoteAudioChangeStatus,
}

enum VCallWsCommand {
    Begin,
    Request,
    Offer,
    Answer,
    Cndidate,
    Identifier,
    Closed,
    Message,
    VideoEnable,
    AudioEnable,
}

/**
 * ### VCallReactNative
 * Video call classes.
 */
export class VCallReactNative {
  
    private options : VCallRemoteConnectOption | undefined;

    private remotes : {[cnnectionId: string] : VCallRemote} = {};

    private ws: WebSocket | undefined;

    private connectionId : string | undefined;

    private eventHandlers : {[handleName: string] : Function} = {};

    private records : Array<VCallRecord> = [];

    public constructor(options: VCallRemoteConnectOption) {
        this.options = options;

        if (!this.options.identifier) this.options.identifier = this.uuid();
        
        this.ws = new WebSocket(this.options.signalingUrl);

        this.ws.onopen = () => {
            if (this.eventHandlers[VCallHandleType.Open]) this.eventHandlers[VCallHandleType.Open]();
            this.send(VCallWsCommand.Begin, { roomId: this.options?.roomId });
        };

        this.ws.onmessage = async (ev) => {
            const data = JSON.parse(ev.data.toString());
            if(!data) return;

            const cmd = data.cmd;

            if (cmd === VCallWsCommand.Begin) {
                // 接続開始
                this.connectionId = data.connectionId;
                this.send(VCallWsCommand.Request);
                console.log("MY ConnectionID = " + this.connectionId);
            }
            else if (cmd === VCallWsCommand.Request) {
                // Request受取

                // remotesに追加
                this.setRemotes(data.from);

                // 相手にIdentifierを送信
                this.sendTo(VCallWsCommand.Identifier, data.from, { identifier: this.options?.identifier });

                // SDP Offer作成＆送信
                await this.sendOffer(data.from);
            }
            else if (cmd === VCallWsCommand.Offer) {
                // Offer受取

                console.log("offer from=", data.from);

                // 相手にIdentifierを送信
                this.sendTo(VCallWsCommand.Identifier, data.from, { identifier: this.options?.identifier });

                // remotesが存在していなければ作成
                this.setRemotes(data.from);

                // Remote Description
                await this.setRemoteDescription(data.from, data.sdp);

                // Answerを作成＆送信
                await this.sendAnswer(data.from);
            }
            else if (cmd === VCallWsCommand.Answer) {
                // Answer受取

                // Remote Description
                await this.setRemoteDescription(data.from, data.sdp);
            }
            else if (cmd === VCallWsCommand.Cndidate) {
                // Candidate受取

                // remotesが存在していなければ作成
                this.setRemotes(data.from);

                this.addCandidate(data.from, data.ice);
            }
            else if (cmd === VCallWsCommand.Identifier) {
                // Identifier受取

                // remotesが存在していなければ作成
                this.setRemotes(data.from);

                // identifierのセット
                const remote = this.remotes[data.from];
                remote.identifier = data.identifier;
            }
            else if (cmd === VCallWsCommand.Closed) {
                // 相手が通話終了
                const remote = this.remotes[data.from];
                if (this.eventHandlers[VCallHandleType.RemoteClosed]) this.eventHandlers[VCallHandleType.RemoteClosed](remote);
            }
            else if (cmd === VCallWsCommand.Message) {
                // 相手からメッセージ受取
                console.log(data);
                if (this.eventHandlers[VCallHandleType.Message]) this.eventHandlers[VCallHandleType.Message](data.message);
            }
            else if (cmd === VCallWsCommand.VideoEnable) {
                // ビデオ有効/無効
                if (this.eventHandlers[VCallHandleType.RemoteVideoChangeStatus]) this.eventHandlers[VCallHandleType.RemoteVideoChangeStatus](data.status, this.remotes[data.from]);
            }
            else if (cmd === VCallWsCommand.AudioEnable) {
                // マイク有効/無効
                if (this.eventHandlers[VCallHandleType.RemoteAudioChangeStatus]) this.eventHandlers[VCallHandleType.RemoteAudioChangeStatus](data.status, this.remotes[data.from]);
            }
        }

        this.ws.onerror = (error) => {
            if (this.eventHandlers[VCallHandleType.Error]) this.eventHandlers[VCallHandleType.Error](error);
        }
    }

    private send(command: VCallWsCommand, sendData?: Object, to?: string) {
        if (!sendData) sendData = {};
        // @ts-ignore
        sendData.cmd = command;
        // @ts-ignore
        sendData.from = this.connectionId;
        // @ts-ignore
        if (to) sendData.to = to;
        this.ws?.send(JSON.stringify(sendData));
    }

    private sendTo(command: VCallWsCommand, to: string, sendData?: Object) {
        this.send(command, sendData, to);
    }

    private uuid() {
        let str : string = "";
        const lbn = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
        for(let n = 0 ; n < 32 ; n++) {
            const ind = Math.round(Math.random() * 1000000) % lbn.length;
            str += lbn[ind];
        }
        return str;
    }

    private setRemotes(guestConnectionId : string) {

        // すでにremotesで作られていればスルー
        if (this.remotes[guestConnectionId]) return;

        const peer = new RTCPeerConnection(this.options?.RTCPeerConnectionConfig);

        // remotesに追加
        const remote : VCallRemote = {
            status: VcallRemoteStatus.Offer,
            connectionId: guestConnectionId,
            peerConnection: peer,
            iceCandidateBuffer: [],
        }
        this.remotes[guestConnectionId] = remote;

        this.options!.localStream!.getTracks().forEach((track) => {
            // @ts-ignore
            remote.peerConnection.addTrack(track, this.options!.localStream!);
        })

        // @ts-ignore
        peer.onicecandidate =(ev: RTCPeerConnectionIceEvent) => {
            if(!ev.candidate) return;
            this.sendTo(VCallWsCommand.Cndidate, guestConnectionId, { ice: ev.candidate });
        }

        // @ts-ignore
        peer.ontrack = (ev: RTCTrackEvent) => {
            if (!ev.streams[0]) return;
            if (remote.status === VcallRemoteStatus.Connected) return;
            const stream = ev.streams[0];
            remote.status = VcallRemoteStatus.Connected;
            // @ts-ignore
            remote.stream = stream;
            if (this.eventHandlers[VCallHandleType.RemoteOpen]) this.eventHandlers[VCallHandleType.RemoteOpen](remote);
        };

        // @ts-ignore
        peer.onconnectionstatechange =(ev) => {
            console.log("connection mode", ev);
        };

        // @ts-ignore
        peer.oniceconnectionstatechange = (ev) => {
            if (peer.iceConnectionState === "disconnected") {
                if (this.eventHandlers[VCallHandleType.RemoteClosed]) this.eventHandlers[VCallHandleType.RemoteClosed](remote);
            }
        };

    }

    private async sendOffer(guestConnectionId: string) {
        const peer = this.remotes[guestConnectionId].peerConnection;
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        this.sendTo(VCallWsCommand.Offer, guestConnectionId, { sdp: offer });             
    }

    private async sendAnswer(guestConnectionId: string) {
        const peer = this.remotes[guestConnectionId].peerConnection;
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.sendTo(VCallWsCommand.Answer, guestConnectionId, { sdp: answer });
    }

    private async setRemoteDescription(guestConnectionId: string, sdp: RTCSessionDescriptionInit) {
        const remote = this.remotes[guestConnectionId];
        try {
            // @ts-ignore
            await remote.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch(error){
            console.error(error);
        }

        // iceCandidateバッファがある場合はadd candidateを実施
        if (remote.iceCandidateBuffer.length) {
            for(let n = 0 ; n < remote.iceCandidateBuffer.length ; n++) {
                const candidate = remote.iceCandidateBuffer[n];
                await remote.peerConnection.addIceCandidate(candidate);
            }

            // すべて完了したらバッファをクリア
            remote.iceCandidateBuffer = [];
        }
    }

    private async addCandidate(guestConnectionId: string, ice: RTCIceCandidate) {
        const remote = this.remotes[guestConnectionId];

        // remote Descriptionが存在する場合はそのままadd
        if (remote.peerConnection.remoteDescription) {
            remote.peerConnection.addIceCandidate(ice);
        }
        // local Descriptionが存在していない場合はバッファにキープ
        else {
            remote.iceCandidateBuffer.push(ice);
        }    
    }

    /**
     * ### Close
     * End video call.
     */
    public close() {

        if (this.remotes) {
            const c = Object.keys(this.remotes);
            for(let n = 0 ; n < c.length ; n++) {
                const guestConnectId = c[n];
                const remote = this.remotes[guestConnectId];
                remote.peerConnection.close();
                this.sendTo(VCallWsCommand.Closed, remote.connectionId);
            }
        }

        this.options?.localStream?.getTracks().forEach((track) => {
            track.stop();
        });

        this.ws?.close();

        if(this.eventHandlers[VCallHandleType.Close]) this.eventHandlers[VCallHandleType.Close]();
    }

    /**
     * ### sendMessage 
     * Send a message to all room members.
     * @param {any} message Message Data
     */
    public sendMessage(message: any) : VCallReactNative;

    /**
     * ### sendMessage
     * Send a message to a specific member.
     * @param {any} message Message Data
     * @param {string} sendConnectionId Destination Connection ID
     */
    public sendMessage(message: any, sendConnectionId: string) : VCallReactNative;

    public sendMessage(message: any, sendConnectionId?: string) : VCallReactNative {
        if (sendConnectionId) {
            this.sendTo(VCallWsCommand.Message, sendConnectionId, { message });
        }
        else {
            this.send(VCallWsCommand.Message, { message });
        }
        return this;
    }

    /**
     * ### recordStart
     * Start recording.
     */
    public recordStart(): VCallReactNative;

    /**
     * ### recordStart
     * Start recording. (Executes the ondataavailable event at the specified time.)
     * @param {number} timeslice Time Interval
     */
    public recordStart(timeslice: number): VCallReactNative;

    public recordStart(timeslice?: number) {
        this.records.push({
            identifier: this.options!.identifier!,
            // @ts-ignore
            record: new MediaRecorder(this.options!.localStream!),
            buffer: [],
        });
        this.records.forEach(rec=>{
            if (this.eventHandlers[VCallHandleType.RecordStart]) this.eventHandlers[VCallHandleType.RecordStart](rec);
            rec.record.ondataavailable = (event) =>{
                if (event.data.size === 0) return;
                rec.buffer.push(event.data);
                if (this.eventHandlers[VCallHandleType.RecordData]) this.eventHandlers[VCallHandleType.RecordData](rec, event.data);
            };
            rec.record.onstop = ()=>{
                if (this.eventHandlers[VCallHandleType.RecordStopped]) this.eventHandlers[VCallHandleType.RecordStopped](rec);
            };
            rec.record.onerror = (error) => {
                if (this.eventHandlers[VCallHandleType.RecordError]) this.eventHandlers[VCallHandleType.RecordError](rec, error);
            };
            rec.record.onresume = () => {
                if (this.eventHandlers[VCallHandleType.REcordResume]) this.eventHandlers[VCallHandleType.REcordResume](rec);
            };
            rec.record.start(timeslice);
        });
        return this;
    }

    /**
     * ### recordStop
     * End recording. (End all member recordings)
     * @param identifier 
     */
    public recordStop() : VCallReactNative;

    /**
     * ### recordStop
     * End recording.
     * @param identifier 
     */
    public recordStop(identifier: string) : VCallReactNative;

    public recordStop(identifier?: string) {
        this.records.forEach((rec)=>{
            if (identifier && identifier !== rec.identifier) return;
            rec.record.stop();                
        });
        return this;
    }

    /**
     * ### Video Enable
     * Change video enable/disable setting.
     * @param {boolean} status enable/disable
     */
    public videoEnable(status: boolean) {
        this.options!.localStream!.getVideoTracks().forEach(track => {
            track.enabled = status;
            this.send(VCallWsCommand.VideoEnable, { status });
        });
    }

    /**
     * ### Audio Enable
     * Change audio enable/disable setting.
     * @param {boolean} status enable/disable
     */
    public audioEnable(status: boolean) {
        this.options!.localStream!.getAudioTracks().forEach(track => {
            track.enabled = status;
            this.send(VCallWsCommand.AudioEnable, { status });
        });
    }

    /**
     * ### onOpen
     * Event handler setting after signaling server connection is completed.
     */
    public set onOpen(callback: ()=>void) {
        this.eventHandlers[VCallHandleType.Open] = callback;
    }

    /**
     * ### onRemoteOpen
     */
    public set onRemoteOpen(callback: (remote: VCallRemote) => void) {
        this.eventHandlers[VCallHandleType.RemoteOpen] = callback;
    }

    /**
     * ### onRemoteClosed
     */
    public set onRemoteClosed(callback: (remote: VCallRemote) => void) {
        this.eventHandlers[VCallHandleType.RemoteClosed] = callback;
    }

    /**
     * ### onClose
     */
    public set onClose(callback: ()=> void) {
        this.eventHandlers[VCallHandleType.Close] = callback;
    }

    /**
     * ### onMessage
     */
    public set onMessage(callback: (message: any)=> void) {
        this.eventHandlers[VCallHandleType.Message] = callback;
    }

    /**
     * ### onError
     */
    public set onError(callback: (error: any)=> void) {
        this.eventHandlers[VCallHandleType.Error] = callback;
    }

    /**
     * ### onRecordeStart
     */
    public set onRecordeStart(callback: (recode: VCallRecord) => void) {
        this.eventHandlers[VCallHandleType.RecordStart] = callback;
    }

    /**
     * ### onRecordData
     */
    public set onRecordData(callback: (recode: VCallRecord, data: Blob) => void) {
        this.eventHandlers[VCallHandleType.RecordData] = callback;
    }

    /**
     * ### onRecordStopped
     */
    public set onRecordStopped(callback: (recode: VCallRecord) => void) {
        this.eventHandlers[VCallHandleType.RecordStopped] = callback;
    }

    /**
     * ### onRecordError
     */
    public set onRecordError(callback: (recode: VCallRecord, error: ErrorEvent) => void) {
        this.eventHandlers[VCallHandleType.RecordError] = callback;
    }

    /**
     * ### onRecordResume
     */
    public set onRecordResume(callback: (recode: VCallRecord) => void) {
        this.eventHandlers[VCallHandleType.REcordResume] = callback;
    }

    /**
     * ### onRemoteVideoChangeStatus
     */
    public set onRemoteVideoChangeStatus(callback: (status: boolean, remote: VCallRemote) => void) {
        this.eventHandlers[VCallHandleType.RemoteVideoChangeStatus] = callback;
    }

    /**
     * ### onRemoteAudioChangeStatus
     */
    public set onRemoteAudioChangeStatus(callback: (status: boolean, remote: VCallRemote) => void) {
        this.eventHandlers[VCallHandleType.RemoteAudioChangeStatus] = callback;
    }

}