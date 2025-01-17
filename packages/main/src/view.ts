/**
 * A View wraps a BrowserView and has a specific AppInstance associated with it
 * Views have
 *    - Channel membership
 *    - Pending Context / Intent (?)
 */

import { ViewConfig } from './types/ViewConfig';
import { getRuntime } from './index';
import { BrowserView } from 'electron';
import { DirectoryApp } from './types/FDC3Data';
import { Context } from '@finos/fdc3';
import { Rectangle } from 'electron/main';
import { Workspace } from './workspace';
import { FDC3Listener } from './types/FDC3Listener';
import { Pending } from './types/Pending';
import { TOOLBAR_HEIGHT } from './constants';
import { SAIL_TOPICS } from '/@/handlers/runtime/topics';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { RUNTIME_TOPICS } from './handlers/runtime/topics';

const FDC3_1_2_PRELOAD = join(
  __dirname,
  '../../preload/dist/fdc3-1.2/index.cjs',
);

const FDC3_2_0_PRELOAD = join(
  __dirname,
  '../../preload/dist/fdc3-2.0/index.cjs',
);

const HOME_PRELOAD = join(__dirname, '../../preload/dist/systemView/index.cjs');

export class View {
  constructor(
    url?: string | null,
    config?: ViewConfig,
    parent?: Workspace,
    fdc3Version?: '2.0' | '1.2',
  ) {
    const VIEW_DEFAULT =
      import.meta.env.DEV &&
      import.meta.env.VITE_DEV_SERVER_DEFAULT_URL !== undefined
        ? import.meta.env.VITE_DEV_SERVER_DEFAULT_URL
        : new URL(
            '../renderer/dist/homeView.html',
            'file://' + __dirname,
          ).toString();

    const setId = () => {
      this.content.webContents.send(SAIL_TOPICS.START, {
        id: this.id,
        directory: this.directoryData || null,
      });
      this.initiated = true;
      console.log('view created', this.id, url);
    };

    const initView = (config?: ViewConfig) => {
      const doInit = () => {
        setId();
        this.size();
        //call onInit handler, if in the config
        if (config && config.onReady) {
          config.onReady.call(this, this);
        }
      };

      doInit();
    };

    this.id = randomUUID();
    this.parent = parent;

    if (fdc3Version) {
      this.fdc3Version = fdc3Version;
    }

    const runtime = getRuntime();

    runtime.getViews().set(this.id, this);

    if (config) {
      this.directoryData = config.directoryData;
    }

    const preload = url
      ? this.fdc3Version === '1.2'
        ? FDC3_1_2_PRELOAD
        : FDC3_2_0_PRELOAD
      : HOME_PRELOAD;

    this.content = new BrowserView({
      webPreferences: {
        preload: preload,
        devTools: true,
        contextIsolation: true,
        webSecurity: true,
        nodeIntegration: true,
      },
    });
    //set bgcolor so view doesn't bleed through to hidden tabs
    this.content.setBackgroundColor('#fff');

    this.content.webContents.on('ipc-message', (event, channel) => {
      if (channel === SAIL_TOPICS.INITIATE && !this.initiated) {
        initView(config);
      }
    });

    //if no URL is defined - then this is the Home view and a system view
    if (!url) {
      url = VIEW_DEFAULT as string;
    }
    if (url === (VIEW_DEFAULT as string)) {
      this.type = 'system';
    }

    if (url) {
      this.content.webContents.loadURL(url).then(() => {
        //       this.content.webContents.openDevTools();
        //   initView(config);
      });

      //listen for reloads and reset id
      this.content.webContents.on('devtools-reload-page', () => {
        this.content.webContents.once('did-finish-load', () => {
          this.content.webContents.send(RUNTIME_TOPICS.WINDOW_START, {
            id: this.id,
            directory: this.directoryData || null,
          });
          console.log('FDC3 start - reload', this.id);
        });
      });

      //listen for navigation
      //to do: ensure directory entry and new location match up!
      this.content.webContents.on('did-navigate', () => {
        this.content.webContents.once('did-finish-load', () => {
          this.content.webContents.send(RUNTIME_TOPICS.WINDOW_START, {
            id: this.id,
            directory: this.directoryData || null,
          });
          console.log('FDC3 start - navigate', this.id);
        });
      });
    }
  }
  /**
   * size the view to the parent
   */
  size() {
    if (this.parent && this.parent.window) {
      const bounds: Rectangle = this.parent.window.getBounds();
      this.content.setBounds({
        x: 0,
        y: TOOLBAR_HEIGHT,
        width: bounds.width,
        height: bounds.height - TOOLBAR_HEIGHT,
      });
    } else {
      this.content.setBounds({
        x: 0,
        y: TOOLBAR_HEIGHT,
        width: 800,
        height: 500,
      });
    }
  }

  id: string;

  content: BrowserView;

  channel: string | null = null;

  /**
   * contexts that the view is listening to
   */
  listeners: Array<FDC3Listener> = [];

  /* array pending contexts
   */
  private pendingContexts: Array<Pending> = [];
  private pendingIntents: Array<Pending> = [];

  directoryData?: DirectoryApp;

  parent?: Workspace;

  initiated = false;

  fdc3Version: '2.0' | '1.2' = '2.0';

  private type: 'system' | 'app' = 'app';

  setPendingContext(context: Context, source?: string): void {
    console.log('view: set pending context', this.id, context);
    this.pendingContexts.push(
      new Pending(this.id, source || this.id, { context: context }),
    );
  }

  getPendingContexts(): Array<Pending> {
    console.log('view: get pending contexts', this.pendingContexts);
    return this.pendingContexts;
  }

  removePendingContext(index: number): void {
    try {
      this.pendingContexts.splice(index, 1);
    } catch (err) {
      console.log('removePendingContext - error', err);
    }
  }

  setPendingIntent(intent: string, context?: Context, source?: string): void {
    this.pendingIntents.push(
      new Pending(this.id, source || this.id, {
        intent: intent,
        context: context,
      }),
    );
  }

  getPendingIntents(): Array<Pending> {
    return this.pendingIntents;
  }

  removePendingIntent(index: number): void {
    try {
      this.pendingIntents.splice(index, 1);
    } catch (err) {
      console.log('removePendingContext - error', err);
    }
  }

  isSystemView = (): boolean => {
    console.log('isSystemView', this.type);
    return this.type === 'system';
  };

  getTitle(): string {
    //is it a system view?
    console.log('View getTitle', this.isSystemView());
    if (this.isSystemView()) {
      return 'Home';
    } else {
      return this.directoryData && this.directoryData.title
        ? this.directoryData.title
        : this.content.webContents.getTitle();
    }
  }

  close() {
    const runtime = getRuntime();
    if (this.parent && this.parent.window) {
      this.parent.window.removeBrowserView(this.content);
    }
    if (this.content) {
      this.content.webContents.closeDevTools();
    }
    //how do you destroy a browser view?
    if (runtime) {
      runtime.getViews().delete(this.id);
    }
  }
}
