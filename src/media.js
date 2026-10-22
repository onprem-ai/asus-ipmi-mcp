// Remote media (virtual CD/HDD from a network share) via the AMI web API.
// Flow used by the web UI (Image Redirection > Remote Media):
//   1. PUT /api/settings/media/general   enable remote media + share address/path/type
//   2. GET /api/settings/media/remote/images      list images found on the share
//   3. POST /api/settings/media/remote/start-media {image_name, image_type, image_redirection:1, image_index}
//   4. POST /api/settings/media/remote/stop-media  {image_name, image_type, image_index}
// image_type: 1 = CD/DVD (.iso/.nrg), 4 = hard disk (.img/.ima)

const TYPE = { cd: 1, hd: 4 };

export async function mediaStatus(bmc) {
  const general = await bmc.api('GET', '/api/settings/media/general');
  const images = await bmc.api('GET', '/api/settings/media/remote/images').catch(() => []);
  const active = await bmc.api('GET', '/api/settings/media/active_redirections').catch(() => []);
  const redact = { ...general };
  for (const k of Object.keys(redact)) if (/password/i.test(k)) redact[k] = redact[k] ? '***' : '';
  return { settings: redact, images, active_redirections: active };
}

/**
 * Configure the share the BMC reads images from.
 * shareType: 'nfs' | 'cifs'. path: export/share path, e.g. "/srv/isos" (nfs) or "isos" (cifs).
 */
export async function configureShare(bmc, { kind = 'cd', server, path, shareType = 'nfs', user = '', password = '', domain = '' }) {
  const cur = await bmc.api('GET', '/api/settings/media/general');
  const p = kind === 'hd' ? 'hd' : 'cd';
  const next = {
    ...cur,
    remote_media_support: 1,
    [`mount_${p}`]: 1,
    [`${p}_remote_server_address`]: server,
    [`${p}_remote_source_path`]: path,
    [`${p}_remote_share_type`]: shareType,
    [`${p}_remote_user_name`]: user,
    [`${p}_remote_password`]: password,
    [`${p}_remote_domain_name`]: domain,
  };
  return bmc.api('PUT', '/api/settings/media/general', next);
}

export async function listImages(bmc) {
  try { await bmc.api('PUT', '/api/settings/media/remote/rmediarefreshlist', {}); } catch { /* not on all firmwares */ }
  return bmc.api('GET', '/api/settings/media/remote/images');
}

export async function startImage(bmc, { image, kind = 'cd', index = 0 }) {
  const type = TYPE[kind];
  if (!type) throw new Error('kind must be "cd" or "hd"');
  const ext = image.split('.').pop().toLowerCase();
  if (type === 1 && !['iso', 'nrg'].includes(ext)) throw new Error('CD/DVD redirection supports .iso/.nrg only');
  if (type === 4 && !['img', 'ima'].includes(ext)) throw new Error('hard-disk redirection supports .img/.ima only');
  return bmc.api('POST', '/api/settings/media/remote/start-media', { image_name: image, image_type: type, image_redirection: 1, image_index: index });
}

export async function stopImage(bmc, { image, kind = 'cd', index = 0 }) {
  return bmc.api('POST', '/api/settings/media/remote/stop-media', { image_name: image, image_type: TYPE[kind], image_index: index });
}
