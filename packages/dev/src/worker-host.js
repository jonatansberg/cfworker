import chalk from 'chalk';
import { EventEmitter } from 'events';
import puppeteer from 'puppeteer';
import { logger } from './logger.js';
import { escapeHeaderName, unescapeHeaderName } from './runtime/headers.js';
import { Server } from './server.js';

export class WorkerHost extends EventEmitter {
  /** @type {import('puppeteer').Browser | undefined} */
  browser = undefined;

  /**
   * @param {number} port
   * @param {boolean} inspect
   */
  constructor(port, inspect) {
    super();
    this.port = port;
    this.inspect = inspect;
    this.server = new Server(port);
    /** @type {Promise<import('puppeteer').Page>} */
    this.pageReady = new Promise(resolve => (this.resolvePage = resolve));
  }

  dispose() {
    this.server.dispose();
    this.browser && this.browser.close();
  }

  async start() {
    let startTime = Date.now();
    logger.progress('Starting server...');
    this.server.serve();

    logger.progress('Starting chrome...');
    const browser = (this.browser = await puppeteer.launch({
      headless: !this.inspect,
      devtools: this.inspect,
      args: [
        '--disable-web-security' // Cloudflare workers are not subject to CORS rules.
      ]
    }));

    logger.progress('Configuring host page...');
    const page = (await browser.pages())[0];
    page.on('pageerror', e => {
      logger.error(e);
      this.emit('worker-error', e);
    });
    await page.exposeFunction('nodeConsoleLog', nodeConsoleLog);

    await this.server.serving;

    logger.progress('Loading host page...');
    await page.goto(`http://localhost:${this.port}${this.server.pathPrefix}/`, {
      waitUntil: ['load']
    });
    await this.forkConsoleLog(page);

    this.server.on('request', this.handleRequestWithWorker);

    logger.success('Worker host ready', Date.now() - startTime);
    this.resolvePage(page);
  }

  /**
   * @param {string} code The worker script.
   * @param {string} sourcePathname Where to list the script in the chrome devtools sources tree.
   * @param {string[]} globals Names of additional globals to expose.
   */
  async setWorkerCode(code, sourcePathname = '/worker.js', globals = []) {
    const startTime = Date.now();
    logger.progress('Updating worker script...');
    const page = await this.pageReady;
    await page.evaluate(
      async (code, sourcePathname, globals) => {
        const { executeWorkerScript } = await import('./runtime/index.js');
        executeWorkerScript(code, sourcePathname, globals);
      },
      code,
      sourcePathname,
      globals
    );
    logger.success('Worker script updated', Date.now() - startTime);
    this.emit('worker-updated');
  }

  async reloadPage() {
    const page = await this.pageReady;
    await page.reload({ waitUntil: ['load'] });
    await this.forkConsoleLog(page);
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   */
  handleRequestWithWorker = async (req, res) => {
    const url = `http://localhost:${this.port}${req.url}`;
    const method = req.method || 'GET';

    this.emit('request-start', method, req.url);

    /** @type {undefined | string} */
    let reqBody = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      reqBody = '';
      await new Promise(resolve => {
        req.on('data', chunk => (reqBody += chunk));
        req.on('end', resolve);
      });
    }

    for (const [key, value] of Array.from(Object.entries(req.headers))) {
      const newKey = escapeHeaderName(key);
      delete req.headers[key];
      req.headers[newKey] = value;
    }
    req.headers['CF-Connecting-IP'] = req.connection.remoteAddress;

    const init = {
      method,
      headers: req.headers,
      body: reqBody
    };

    const page = await this.pageReady;
    const { status, statusText, headers, body } = await page.evaluate(
      async (url, init) => {
        const { dispatchFetchEvent } = await import('./runtime/index.js');
        return dispatchFetchEvent(url, init);
      },
      url,
      // @ts-ignore
      init
    );

    for (const [key, value] of Array.from(Object.entries(headers))) {
      const newKey = unescapeHeaderName(key);
      delete headers[key];
      headers[newKey] = value;
    }

    res.writeHead(status, statusText, headers);
    res.write(body);
    res.end();
    logger.log(statusChalk(status)(`${status} ${method.padEnd(7)} ${url}`));
    this.emit('request-end', method, url, status, statusText);
  };

  /**
   * @param {import('puppeteer').Page} page
   */
  async forkConsoleLog(page) {
    await page.evaluate(() => {
      /** @type {('log' | 'debug' | 'info' | 'warn' | 'error')[]} */
      const methods = ['log', 'debug', 'info', 'warn', 'error'];
      for (const method of methods) {
        const browser = console[method];
        /** @type {(...args: any[]) => void} */
        console[method] = function (...args) {
          browser(...args);
          nodeConsoleLog(...args);
        };
      }
    });
  }
}

/** @type {(...args: any[]) => void} */
const nodeConsoleLog = (...args) => logger.log(...args);

/**
 * @param {number} code
 */
function statusChalk(code) {
  if (code >= 500) {
    return chalk.red.dim;
  }
  if (code >= 400) {
    return chalk.gray.dim;
  }
  if (code >= 300) {
    return chalk.yellow.dim;
  }
  if (code >= 200) {
    return chalk.green.dim;
  }
  return chalk.blue.dim;
}
