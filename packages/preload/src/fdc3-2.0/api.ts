import { ipcRenderer } from 'electron';
import { fdc3Event, TOPICS } from '../lib/lib';
import {
  FDC3Message,
  FDC3MessageData,
  FDC3Response,
} from '/@main/types/FDC3Message';
import { DesktopAgent, Listener } from '@finos/fdc3';
import {
  AppIntent,
  Context,
  DisplayMetadata,
  ContextHandler,
  Channel,
  PrivateChannel,
  ImplementationMetadata,
  IntentResolution,
  AppIdentifier,
  AppMetadata,
} from '@finos/fdc3';
import { FDC3Event } from '/@main/types/FDC3Event';
import { ChannelData } from '/@main/types/FDC3Data';
import { FDC3EventEnum } from '/@main/types/FDC3Event';
import { FDC3_TOPICS } from '/@main/handlers/fdc3/2.0/topics';

/** generate pseudo-random ids for handlers created on the client */
const guid = (): string => {
  const gen = (n?: number): string => {
    const rando = (): string => {
      return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .substring(1);
    };
    let r = '';
    let i = 0;
    n = n ? n : 1;
    while (i < n) {
      r += rando();
      i++;
    }
    return r;
  };

  return `${gen(2)}-${gen()}-${gen()}-${gen()}-${gen(3)}`;
};

interface FDC3ReturnListener {
  ts: number;
  listener: { (msg: FDC3Message): void };
}

//flag to indicate the background script is ready for fdc3!
let instanceId = '';

//queue of pending events - accumulate until the background is ready
const eventQ: Array<FDC3Message> = [];

//collection of listeners for api calls coming back from the background script
const returnListeners: Map<string, FDC3ReturnListener> = new Map();

export const connect = () => {
  /**
   * listen for incomming contexts
   */
  ipcRenderer.on(FDC3_TOPICS.CONTEXT, async (event, args) => {
    console.log('ipcrenderer event', event.type, args);
    //check for handlers at the content script layer (automatic handlers) - if not, dispatch to the API layer...
    //   let contextSent = false;
    if (args.data && args.data.context) {
      if (args.listenerIds) {
        const listeners: Array<string> = args.listenerIds;
        listeners.forEach((listenerId) => {
          const data = args.data;
          data.listenerId = listenerId;

          document.dispatchEvent(
            new CustomEvent(TOPICS.FDC3_CONTEXT, {
              detail: { data: data, source: args.source },
            }),
          );
        });
      } else if (args.listenerId) {
        const data = args.data;
        data.listenerId = args.listenerId;
        document.dispatchEvent(
          new CustomEvent(TOPICS.FDC3_CONTEXT, {
            detail: { data: data, source: args.source },
          }),
        );
      }

      // }
    }
  });

  /**
   * listen for incoming intents
   */
  ipcRenderer.on(FDC3_TOPICS.INTENT, (event, args) => {
    console.log('ipcrenderer event', event.type);
    document.dispatchEvent(
      new CustomEvent(TOPICS.FDC3_INTENT, {
        detail: { data: args.data, source: args.source },
      }),
    );
  });

  /**
   * listen for channel state update
   * to do: do we need this?
   */
  /*ipcRenderer.on(RUNT.SET_CURRENT_CHANEL, (event, args) => {
    console.log('ipcrenderer event', event.type);
    if (args.data.channel) {
      //  currentChannel = args.data.channel;
    }
  });*/
};

//handshake with main and get instanceId assigned
ipcRenderer.on(FDC3_TOPICS.START, async (event, args) => {
  console.log('api FDC3 start', args);
  if (args.id) {
    instanceId = args.id;
    //send any queued messages
    eventQ.forEach((msg) => {
      sendMessage(msg.topic, msg.data);
    });
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => {
        console.log('fdc3Ready');
        document.dispatchEvent(new CustomEvent('fdc3Ready', {}));
      });
    } else {
      console.log('fdc3Ready');
      document.dispatchEvent(new CustomEvent('fdc3Ready', {}));
    }
  }
});

//send messages to main, handle responses, queue messages if not connected yet

const sendMessage = (topic: string, data: FDC3MessageData): Promise<any> => {
  //set up a return listener and assign as eventId
  return new Promise((resolve, reject) => {
    const eventId = `${topic}_${guid()}`;
    data.eventId = eventId;
    returnListeners.set(eventId, {
      ts: Date.now(),
      listener: (response: FDC3Response) => {
        if (response.error) {
          reject(response.error);
        }
        resolve(response.data);
      },
    });

    if (instanceId) {
      const { port1, port2 } = new MessageChannel();

      port1.onmessage = (event: MessageEvent) => {
        //is there a returnlistener registered for the event?
        const listenerEntry = returnListeners.get(event.data.topic);
        const listener = listenerEntry ? listenerEntry.listener : null;
        if (listener) {
          returnListeners.delete(event.data.topic);
          console.log('sendMessage - calling listener', event.data.data);
          resolve(listener.call(window, event.data.data));
        }
      };
      const msg: FDC3Message = { topic: topic, data: data, source: instanceId };
      console.log('send message to main', topic, msg);
      ipcRenderer.postMessage(topic, msg, [port2]);
    } else {
      const msg: FDC3Message = { topic: topic, data: data, source: '-1' };
      eventQ.push(msg);
    }
  });
};

/**
 * This file is injected into each Chrome tab by the Content script to make the FDC3 API available as a global
 */

export const createAPI = (): DesktopAgent => {
  /**
   *  the Listener class
   */
  class FDC3Listener implements Listener {
    private id: string;

    type: string;

    intent: string | null = null;

    constructor(type: string, listenerId: string, intent?: string) {
      this.id = listenerId;
      this.type = type;
      if (type === 'intent' && intent) {
        this.intent = intent;
      }

      this.unsubscribe = () => {
        if (this.type === 'context') {
          _contextListeners.delete(this.id);

          sendMessage(FDC3EventEnum.DropContextListener, {
            id: this.id,
          });
        } else if (this.type === 'intent' && this.intent) {
          const listeners = _intentListeners.get(this.intent);
          if (listeners) {
            listeners.delete(this.id);
          }
          //notify the background script
          document.dispatchEvent(
            fdc3Event(FDC3EventEnum.DropIntentListener, {
              id: this.id,
              intent: this.intent,
            }),
          );
        }
      };
    }

    unsubscribe: () => void;
  }

  interface ListenerItem {
    id?: string;
    handler?: ContextHandler;
    contextType?: string;
  }

  const createListenerItem = (
    id: string,
    handler: ContextHandler,
    contextType?: string,
  ): ListenerItem => {
    const listener: ListenerItem = {};
    listener.id = id;
    listener.handler = handler;
    listener.contextType = contextType;

    return listener;
  };

  const createChannelObject = (
    id: string,
    type: 'user' | 'app' | 'private',
    displayMetadata: DisplayMetadata,
  ): Channel => {
    const channel: Channel = {
      id: id,
      type: type,
      displayMetadata: displayMetadata,
      broadcast: async (context: Context): Promise<void> => {
        sendMessage('broadcast', { context: context, channel: channel.id });
        return;
      },
      getCurrentContext: (contextType?: string) => {
        return new Promise((resolve, reject) => {
          sendMessage('getCurrentContext', {
            channel: channel.id,
            contextType: contextType,
          }).then(
            (r) => {
              const result: Context = r as Context;
              resolve(result);
            },
            (err) => {
              reject(err);
            },
          );
        });
      },

      addContextListener: async (
        contextType: ContextHandler | string | null,
        handler?: ContextHandler,
      ): Promise<Listener> => {
        const thisListener: ContextHandler = handler
          ? handler
          : (contextType as ContextHandler);
        const thisContextType = handler ? (contextType as string) : undefined;
        const listenerId: string = guid();

        _contextListeners.set(
          listenerId,
          createListenerItem(listenerId, thisListener, thisContextType),
        );

        sendMessage(FDC3_TOPICS.ADD_CONTEXT_LISTENER, {
          id: listenerId,
          channel: channel.id,
          contextType: thisContextType,
        });
        return new FDC3Listener('context', listenerId);
      },
    };

    return channel;
  };

  function openFunc(
    name: string,
    context?: Context | undefined,
  ): Promise<AppIdentifier>;
  function openFunc(
    app: AppIdentifier,
    context?: Context | undefined,
  ): Promise<AppIdentifier>;
  async function openFunc(
    appArg: unknown,
    contextArg?: Context | undefined,
  ): Promise<AppIdentifier> {
    await sendMessage(FDC3_TOPICS.OPEN, {
      target: appArg as AppIdentifier,
      context: contextArg,
    });

    return new Promise((resolve) => {
      resolve(appArg as AppIdentifier);
    });
  }

  function raiseIntent(
    intent: string,
    context: Context,
    app?: AppIdentifier | undefined,
  ): Promise<IntentResolution>;
  function raiseIntent(
    intent: string,
    context: Context,
    name?: string,
  ): Promise<IntentResolution>;
  async function raiseIntent(
    intent: string,
    context: Context,
    appIdentity?: unknown,
  ): Promise<IntentResolution> {
    return await sendMessage(FDC3_TOPICS.RAISE_INTENT, {
      intent: intent,
      context: context,
      target:
        typeof appIdentity === 'string'
          ? ({ appId: appIdentity } as AppIdentifier)
          : (appIdentity as AppIdentifier),
    });
  }

  function raiseIntentForContext(
    context: Context,
    app?: AppIdentifier | undefined,
  ): Promise<IntentResolution>;
  function raiseIntentForContext(
    context: Context,
    name?: string,
  ): Promise<IntentResolution>;
  async function raiseIntentForContext(
    context: Context,
    appIdentity?: unknown,
  ): Promise<IntentResolution> {
    return await sendMessage(FDC3_TOPICS.RAISE_INTENT_FOR_CONTEXT, {
      context: context,
      target:
        typeof appIdentity === 'string'
          ? ({ appId: appIdentity } as AppIdentifier)
          : (appIdentity as AppIdentifier),
    });
  }

  const desktopAgent: DesktopAgent = {
    getInfo: async (): Promise<ImplementationMetadata> => {
      return {
        fdc3Version: '2.0',
        provider: 'fdc3-sail',
        optionalFeatures: {
          OriginatingAppMetadata: true,
          UserChannelMembershipAPIs: true,
        },
        appMetadata: {
          appId: 'unknown',
        },
      };
    },

    findInstances: async (
      app: AppIdentifier,
    ): Promise<Array<AppIdentifier>> => {
      const result: Array<AppIdentifier> = [app];
      return result;
    },

    getAppMetadata: async (app: AppIdentifier): Promise<AppMetadata> => {
      return {
        name: '',
        appId: app.appId,
      };
    },

    open: openFunc,

    broadcast: async (context: Context) => {
      //void
      return await sendMessage(FDC3_TOPICS.BROADCAST, { context: context });
    },

    raiseIntent: raiseIntent,

    raiseIntentForContext: raiseIntentForContext,

    addContextListener: async (
      contextType: ContextHandler | string | null,
      handler?: ContextHandler,
    ): Promise<Listener> => {
      const thisListener: ContextHandler = handler
        ? handler
        : (contextType as ContextHandler);
      const thisContextType: string | undefined =
        contextType && handler ? (contextType as string) : undefined;
      const listenerId: string = guid();
      _contextListeners.set(
        listenerId,
        createListenerItem(listenerId, thisListener, thisContextType),
      );

      sendMessage(FDC3_TOPICS.ADD_CONTEXT_LISTENER, {
        id: listenerId,
        contextType: thisContextType,
      });

      return new FDC3Listener('context', listenerId);
    },

    addIntentListener: async (
      intent: string,
      listener: ContextHandler,
    ): Promise<Listener> => {
      const listenerId: string = guid();
      if (!_intentListeners.has(intent)) {
        _intentListeners.set(intent, new Map());
      }
      const listeners = _intentListeners.get(intent);
      if (listeners) {
        listeners.set(listenerId, createListenerItem(listenerId, listener));

        sendMessage(FDC3_TOPICS.ADD_INTENT_LISTENER, {
          id: listenerId,
          intent: intent,
        });
      }
      return new FDC3Listener('intent', listenerId, intent);
    },

    findIntent: async (
      intent: string,
      context: Context,
    ): Promise<AppIntent> => {
      return await sendMessage(FDC3_TOPICS.FIND_INTENT, {
        intent: intent,
        context: context,
      });
    },

    findIntentsByContext: async (
      context: Context,
    ): Promise<Array<AppIntent>> => {
      return await sendMessage(FDC3_TOPICS.FIND_INTENTS_BY_CONTEXT, {
        context: context,
      });
    },

    getSystemChannels: async (): Promise<Array<Channel>> => {
      const r: Array<ChannelData> = await sendMessage(
        FDC3_TOPICS.GET_SYSTEM_CHANNELS,
        {},
      );
      console.log('result', r);
      const channels = r.map((c: ChannelData) => {
        return createChannelObject(
          c.id,
          'user',
          c.displayMetadata || { name: c.id },
        );
      });
      return channels;
    },

    getUserChannels: async (): Promise<Array<Channel>> => {
      const r: Array<ChannelData> = await sendMessage(
        FDC3_TOPICS.GET_USER_CHANNELS,
        {},
      );
      console.log('result', r);
      const channels = r.map((c: ChannelData) => {
        return createChannelObject(
          c.id,
          'user',
          c.displayMetadata || { name: c.id },
        );
      });
      return channels;
    },

    createPrivateChannel: async (): Promise<PrivateChannel> => {
      const channelId = guid();
      return createChannelObject(channelId, 'private', {
        name: channelId,
      }) as PrivateChannel;
    },

    getOrCreateChannel: async (channelId: string) => {
      const result: ChannelData = await sendMessage(
        FDC3_TOPICS.GET_OR_CREATE_CHANNEL,
        { channelId: channelId },
      );
      return createChannelObject(
        result.id,
        result.type as 'user' | 'app' | 'private',
        result.displayMetadata || { name: result.id },
      );
    },

    joinUserChannel: async (channel: string) => {
      return await sendMessage(FDC3_TOPICS.JOIN_USER_CHANNEL, {
        channel: channel,
      });
    },

    joinChannel: async (channel: string) => {
      return await sendMessage(FDC3_TOPICS.JOIN_CHANNEL, { channel: channel });
    },

    leaveCurrentChannel: async () => {
      return await sendMessage(FDC3_TOPICS.LEAVE_CURRENT_CHANNEL, {});
    },

    getCurrentChannel: async () => {
      const result: ChannelData = await sendMessage(
        FDC3_TOPICS.GET_CURRENT_CHANNEL,
        {},
      );

      return createChannelObject(
        result.id,
        result.type as 'user' | 'app' | 'private',
        result.displayMetadata || { name: result.id },
      );
    },
  };

  document.addEventListener(TOPICS.FDC3_CONTEXT, ((event: FDC3Event) => {
    console.log('Context', JSON.stringify(_contextListeners));
    const listeners = _contextListeners;
    if (
      event.detail &&
      event.detail.data &&
      event.detail.data.listenerId &&
      listeners.has(event.detail.data.listenerId)
    ) {
      const listener = listeners.get(event.detail.data.listenerId);
      const context = event.detail.data && event.detail.data.context;
      if (listener && listener.handler && context) {
        listener.handler.call(document, context);
      }
    }
  }) as EventListener);

  document.addEventListener(TOPICS.FDC3_INTENT, ((event: FDC3Event) => {
    const intent = event.detail.data && event.detail.data.intent;
    const context = event.detail.data && event.detail.data.context;
    if (intent) {
      const listeners = _intentListeners.get(intent);
      const result = null;
      if (listeners) {
        listeners.forEach((l) => {
          if (l.handler && context) {
            l.handler.call(document, context);
          }
        });
      }
      //emit return event
      document.dispatchEvent(
        fdc3Event(FDC3EventEnum.IntentComplete, { data: result }),
      );
    }
  }) as EventListener);

  //map of context listeners by id
  const _contextListeners: Map<string, ListenerItem> = new Map();

  //map of intents holding map of listeners for each intent
  const _intentListeners: Map<string, Map<string, ListenerItem>> = new Map();

  //prevent timing issues from very first load of the preload
  ipcRenderer.send(TOPICS.FDC3_INITIATE, {});

  return desktopAgent;
};
