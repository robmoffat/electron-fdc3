import { getRuntime } from '/@/index';
import { RuntimeMessage } from '/@/handlers/runtimeMessage';
import { AppIdentifier, OpenError } from '@finos/fdc3';
import {
  DirectoryApp,
  DirectoryAppLaunchDetails,
  DirectoryAppLaunchDetailsWeb,
} from '/@/directory/directory';

function isWeb(
  details: DirectoryAppLaunchDetails,
): details is DirectoryAppLaunchDetailsWeb {
  return Object.hasOwn(details, 'url');
}

export const open = async (message: RuntimeMessage) => {
  console.log('open', message);
  const runtime = getRuntime();
  const appIdentifier: AppIdentifier = message.data.appIdentifier;

  const allResults: DirectoryApp[] = runtime
    .getDirectory()
    .retrieveByAppId(appIdentifier.appId);

  const result = allResults ? allResults[0] : null;

  if (result && result.type == 'web') {
    //get target workspace
    const sourceView = runtime.getView(message.source);
    const work =
      runtime.getWorkspace(message.source) || (sourceView && sourceView.parent);
    const details = result.details as DirectoryAppLaunchDetails;
    if (isWeb(details)) {
      const newView =
        work && work.createView(details.url, { directoryData: result });

      //set provided context
      if (newView && message.data.context) {
        newView.setPendingContext(message.data.context, message.source);
      }
      return;
    }
  }
  throw OpenError.AppNotFound;
};
