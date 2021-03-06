import fs from 'fs';
import path from 'path';

import 'babel-polyfill';
import { oneLine } from 'common-tags';
import defaultConfig from 'config';
import Express from 'express';
import helmet from 'helmet';
import Raven from 'raven';
import cookie from 'react-cookie';
import React from 'react';
import ReactDOM from 'react-dom/server';
import NestedStatus from 'react-nested-status';
import { Provider } from 'react-redux';
import { match } from 'react-router';
import { ReduxAsyncConnect, loadOnServer } from 'redux-connect';
import { loadFail } from 'redux-connect/lib/store';
import { END } from 'redux-saga';
import WebpackIsomorphicTools from 'webpack-isomorphic-tools';

import log from 'core/logger';
import { createApiError } from 'core/api';
import ServerHtml from 'core/containers/ServerHtml';
import * as middleware from 'core/middleware';
import { convertBoolean } from 'core/utils';
import { setAuthToken, setClientApp, setLang, setUserAgent }
  from 'core/actions';
import {
  getDirection,
  isValidLang,
  langToLocale,
  makeI18n,
} from 'core/i18n/utils';
import I18nProvider from 'core/i18n/Provider';

import WebpackIsomorphicToolsConfig from './webpack-isomorphic-tools-config';


export function getPageProps({ noScriptStyles = '', store, req, res, config }) {
  const appName = config.get('appName');
  const isDeployed = config.get('isDeployed');

  // Get SRI for deployed services only.
  const sriData = (isDeployed) ? JSON.parse(
    fs.readFileSync(path.join(config.get('basePath'), 'dist/sri.json'))
  ) : {};

  // Check the lang supplied by res.locals.lang for validity
  // or fall-back to the default.
  const lang = isValidLang(res.locals.lang) ?
    res.locals.lang : config.get('defaultLang');
  const dir = getDirection(lang);
  store.dispatch(setLang(lang));
  if (res.locals.clientApp) {
    store.dispatch(setClientApp(res.locals.clientApp));
  } else if (req && req.url) {
    log.warn(`No clientApp for this URL: ${req.url}`);
  } else {
    log.warn('No clientApp (error)');
  }
  if (res.locals.userAgent) {
    store.dispatch(setUserAgent(res.locals.userAgent));
  } else {
    log.info('No userAgent found in request headers.');
  }

  return {
    appName,
    assets: webpackIsomorphicTools.assets(),
    htmlLang: lang,
    htmlDir: dir,
    includeSri: isDeployed,
    noScriptStyles,
    sriData,
    store,
    trackingEnabled: (
      convertBoolean(config.get('trackingEnabled')) &&
      req.header('dnt') !== '1' // A DNT header set to "1" means Do Not Track
    ),
  };
}

function showErrorPage({ createStore, error = {}, req, res, status, config }) {
  const { store } = createStore();
  const pageProps = getPageProps({ store, req, res, config });

  const componentDeclaredStatus = NestedStatus.rewind();
  let adjustedStatus = status || componentDeclaredStatus || 500;
  if (error.response && error.response.status) {
    adjustedStatus = error.response.status;
  }

  const apiError = createApiError({ response: { status: adjustedStatus } });
  store.dispatch(loadFail('ServerBase', { ...apiError, ...error }));

  const HTML = ReactDOM.renderToString(
    <ServerHtml {...pageProps} />);
  return res.status(adjustedStatus)
    .send(`<!DOCTYPE html>\n${HTML}`)
    .end();
}


function hydrateOnClient({ res, props = {}, pageProps }) {
  const HTML =
    ReactDOM.renderToString(<ServerHtml {...pageProps} {...props} />);
  const componentDeclaredStatus = NestedStatus.rewind();
  return res.status(componentDeclaredStatus)
    .send(`<!DOCTYPE html>\n${HTML}`)
    .end();
}

function baseServer(routes, createStore, {
  appSagas,
  appInstanceName = null,
  config = defaultConfig,
} = {}) {
  const appName = appInstanceName !== null ? appInstanceName : config.get('appName');

  const app = new Express();
  app.disable('x-powered-by');

  const sentryDsn = config.get('sentryDsn');
  if (sentryDsn) {
    Raven.config(sentryDsn, { logger: 'server-js' }).install();
    app.use(Raven.requestHandler());
    log.info(`Sentry reporting configured with DSN ${sentryDsn}`);
    // The error handler is defined below.
  } else {
    log.warn('Sentry reporting is disabled; Set config.sentryDsn to enable it.');
  }

  app.use(middleware.logRequests);

  // Set HTTP Strict Transport Security headers
  app.use(middleware.hsts());

  // Sets X-Frame-Options
  app.use(middleware.frameguard());

  // Sets x-content-type-options:"nosniff"
  app.use(helmet.noSniff());

  // Sets x-xss-protection:"1; mode=block"
  app.use(helmet.xssFilter());

  // CSP configuration.
  const noScriptStyles = middleware.getNoScriptStyles(appName);
  app.use(middleware.csp({ noScriptStyles }));

  // Serve assets locally from node ap (no-op by default).
  if (config.get('enableNodeStatics')) {
    app.use(middleware.serveAssetsLocally());
  }

  // Show version/commit information as JSON.
  function viewVersion(req, res) {
    // This is a magic file that gets written by deployment scripts.
    const version = path.join(config.get('basePath'), 'version.json');

    fs.stat(version, (error) => {
      if (error) {
        log.error(`Could not stat version file ${version}: ${error}`);
        res.sendStatus(415);
      } else {
        res.setHeader('Content-Type', 'application/json');
        fs.createReadStream(version).pipe(res);
      }
    });
  }

  // Following the ops monitoring convention, return version info at this URL.
  app.get('/__version__', viewVersion);
  // For AMO, this helps differentiate from /__version__ served by addons-server.
  app.get('/__frontend_version__', viewVersion);

  // Return 200 for csp reports - this will need to be overridden when deployed.
  app.post('/__cspreport__', (req, res) => res.status(200).end('ok'));

  const isDevelopment = config.get('isDevelopment');
  if (appName === 'disco' && isDevelopment) {
    app.get('/', (req, res) =>
      res.redirect(302, '/en-US/firefox/discovery/pane/48.0/Darwin/normal'));
  }

  // Handle application and lang redirections.
  if (config.get('enablePrefixMiddleware')) {
    app.use(middleware.prefixMiddleware);
  }

  // Add trailing slashes to URLs
  if (config.get('enableTrailingSlashesMiddleware')) {
    app.use(middleware.trailingSlashesMiddleware);
  }

  app.use((req, res, next) => {
    if (isDevelopment) {
      log.info(oneLine`Clearing require cache for webpack isomorphic tools.
        [Development Mode]`);

      // clear require() cache if in development mode
      webpackIsomorphicTools.refresh();
    }

    const cacheAllResponsesFor = config.get('cacheAllResponsesFor');
    if (cacheAllResponsesFor) {
      if (!isDevelopment) {
        throw new Error(oneLine`You cannot simulate the cache with
          the cacheAllResponsesFor config value when isDevelopment is false.
          In other words, we already do caching in hosted environments
          (via nginx) so this would be confusing!`);
      }
      log.warn(oneLine`Sending a Cache-Control header so that the client caches
        all requests for ${cacheAllResponsesFor} seconds`);
      res.set('Cache-Control', `public, max-age=${cacheAllResponsesFor}`);
    }

    // Vary the cache on Do Not Track headers.
    res.vary('DNT');

    match({ location: req.url, routes }, (
      matchError, redirectLocation, renderProps
    ) => {
      if (matchError) {
        log.info(`match() returned an error for ${req.url}: ${matchError}`);
        return next(matchError);
      }
      if (!renderProps) {
        log.info(`match() did not return renderProps for ${req.url}`);
        return showErrorPage({ createStore, status: 404, req, res, config });
      }

      let htmlLang;
      let locale;
      let pageProps;
      let runningSagas;
      let sagaMiddleware;
      let store;

      try {
        cookie.plugToRequest(req, res);

        const storeAndSagas = createStore();
        sagaMiddleware = storeAndSagas.sagaMiddleware;
        store = storeAndSagas.store;

        let sagas = appSagas;
        if (!sagas) {
          // eslint-disable-next-line global-require, import/no-dynamic-require
          sagas = require(`${appName}/sagas`).default;
        }
        runningSagas = sagaMiddleware.run(sagas);

        const token = cookie.load(config.get('cookieName'));
        if (token) {
          store.dispatch(setAuthToken(token));
        }

        pageProps = getPageProps({ noScriptStyles, store, req, res, config });
        if (config.get('disableSSR') === true) {
          // This stops all running sagas.
          store.dispatch(END);

          return runningSagas.done.then(() => {
            log.warn('Server side rendering is disabled.');
            return hydrateOnClient({ res, pageProps });
          });
        }

        htmlLang = pageProps.htmlLang;
        locale = langToLocale(htmlLang);
      } catch (preLoadError) {
        log.info(`Caught an error in match() before loadOnServer(): ${preLoadError}`);
        return next(preLoadError);
      }

      return loadOnServer({ ...renderProps, store })
        .then(() => {
          // eslint-disable-next-line global-require
          let i18nData = {};
          try {
            if (locale !== langToLocale(config.get('defaultLang'))) {
              // eslint-disable-next-line global-require, import/no-dynamic-require
              i18nData = require(`../../locale/${locale}/${appName}.js`);
            }
          } catch (e) {
            log.info(`Locale JSON not found or required for locale: "${locale}"`);
            log.info(`Falling back to default lang: "${config.get('defaultLang')}".`);
          }
          const i18n = makeI18n(i18nData, htmlLang);

          const InitialComponent = (
            <I18nProvider i18n={i18n}>
              <Provider store={store} key="provider">
                <ReduxAsyncConnect {...renderProps} />
              </Provider>
            </I18nProvider>
          );

          const errorPage = store.getState().errorPage;
          if (errorPage && errorPage.hasError) {
            log.info(`Error page was dispatched to state: ${errorPage.error}`);
            throw errorPage.error;
          }

          const props = { component: InitialComponent };

          // We need to render once because it will force components to
          // dispatch data loading actions which get processed by sagas.
          log.info('First component render to dispatch loading actions');
          ReactDOM.renderToString(<ServerHtml {...pageProps} {...props} />);

          // Send the redux-saga END action to stop sagas from running
          // indefinitely. This is only done for server-side rendering.
          store.dispatch(END);

          // Once all sagas have completed, we load the page.
          return runningSagas.done.then(() => {
            log.info('Second component render after sagas have finished');
            return hydrateOnClient({ props, pageProps, res });
          });
        })
        .catch((loadError) => {
          log.error(`Caught error from loadOnServer(): ${loadError}`);
          next(loadError);
        });
    });
  });

  // Error handlers:

  if (sentryDsn) {
    app.use(Raven.errorHandler());
  }

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      log.warn(oneLine`Ignoring error for ${req.url}
        because a response was already sent; error: ${error}`);
      return next(error);
    }

    log.error(`Showing 500 page for error: ${error}`);
    log.error({ err: error }); // log the stack trace too.
    return showErrorPage({ createStore, error, status: 500, req, res, config });
  });

  return app;
}

export function runServer({
  listen = true,
  exitProcess = true,
  config = defaultConfig,
} = {}) {
  const port = config.get('serverPort');
  const host = config.get('serverHost');
  const appName = config.get('appName');

  const isoMorphicServer = new WebpackIsomorphicTools(WebpackIsomorphicToolsConfig);

  return new Promise((resolve) => {
    if (!appName) {
      throw new Error(`Please specify a valid appName from ${config.get('validAppNames')}`);
    }
    resolve();
  })
    .then(() => isoMorphicServer.server(config.get('basePath')))
    .then(() => {
      global.webpackIsomorphicTools = isoMorphicServer;
      // Webpack Isomorphic tools is ready
      // now fire up the actual server.
      return new Promise((resolve, reject) => {
        /* eslint-disable global-require, import/no-dynamic-require */
        const routes = require(`${appName}/routes`).default;
        const createStore = require(`${appName}/store`).default;
        /* eslint-enable global-require, import/no-dynamic-require */
        const server = baseServer(
          routes, createStore, { appInstanceName: appName });
        if (listen === true) {
          server.listen(port, host, (err) => {
            if (err) {
              return reject(err);
            }
            const proxyEnabled = convertBoolean(config.get('proxyEnabled'));
            // Not using oneLine here since it seems to change '  ' to ' '.
            log.info([
              `🔥  Addons-frontend server is running`,
              `[ENV:${config.util.getEnv('NODE_ENV')}]`,
              `[APP:${appName}]`,
              `[isDevelopment:${config.get('isDevelopment')}]`,
              `[isDeployed:${config.get('isDeployed')}]`,
              `[apiHost:${config.get('apiHost')}]`,
              `[apiPath:${config.get('apiPath')}]`,
            ].join(' '));
            if (proxyEnabled) {
              const proxyPort = config.get('proxyPort');
              log.info(
                `🚦  Proxy detected, frontend running at http://${host}:${port}.`);
              log.info(
                `👁  Open your browser at http://localhost:${proxyPort} to view it.`);
            } else {
              log.info(
                `👁  Open your browser at http://${host}:${port} to view it.`);
            }
            return resolve(server);
          });
        } else {
          resolve(server);
        }
      });
    })
    .catch((err) => {
      log.error({ err });
      if (exitProcess) {
        process.exit(1);
      } else {
        throw err;
      }
    });
}

export default baseServer;
