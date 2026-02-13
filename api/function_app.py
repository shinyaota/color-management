import base64
import io
import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import azure.functions as func
from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
from azure.storage.blob import BlobServiceClient, BlobSasPermissions, ContentSettings, generate_blob_sas

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

METHODS = ['Cheung 2004', 'Finlayson 2015', 'Vandermonde', 'TPS-3D']

UPLOAD_CONTAINER = os.environ.get('COLOR_CONTAINER_UPLOADS', 'uploads')
OUTPUT_CONTAINER = os.environ.get('COLOR_CONTAINER_OUTPUTS', 'outputs')
JOB_CONTAINER = os.environ.get('COLOR_CONTAINER_JOBS', 'jobs')
QUEUE_NAME = os.environ.get('COLOR_QUEUE_NAME', 'colorjobs')
STORAGE_CONNECTION_SETTING = os.environ.get('COLOR_STORAGE_CONNECTION_SETTING', 'AzureWebJobsStorage')

RGB_SPACE = None
REFERENCE_SWATCHES = None
imageio = None
np = None
colour = None
RGB_COLOURSPACES = None
delta_E_CIE2000 = None
RGB_to_XYZ = None
XYZ_to_Lab = None
Lab_to_XYZ = None
XYZ_to_RGB = None
eotf_inverse_sRGB = None
eotf_sRGB = None
SETTINGS_DETECTION_COLORCHECKER_CLASSIC = None
SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC = None
extractor_segmentation = None
segmenter_default = None


def _lazy_imports():
    global imageio
    global np
    global colour
    global RGB_COLOURSPACES
    global delta_E_CIE2000
    global RGB_to_XYZ
    global XYZ_to_Lab
    global Lab_to_XYZ
    global XYZ_to_RGB
    global eotf_inverse_sRGB
    global eotf_sRGB
    global SETTINGS_DETECTION_COLORCHECKER_CLASSIC
    global SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC
    global extractor_segmentation
    global segmenter_default
    global RGB_SPACE
    global REFERENCE_SWATCHES

    if RGB_SPACE is not None:
        return

    try:
        import imageio.v2 as _imageio
        import numpy as _np
        import colour as _colour
        from colour import RGB_COLOURSPACES as _RGB_COLOURSPACES
        from colour.difference import delta_E_CIE2000 as _delta_E_CIE2000
        from colour.models import (
            RGB_to_XYZ as _RGB_to_XYZ,
            XYZ_to_Lab as _XYZ_to_Lab,
            Lab_to_XYZ as _Lab_to_XYZ,
            XYZ_to_RGB as _XYZ_to_RGB,
            eotf_inverse_sRGB as _eotf_inverse_sRGB,
            eotf_sRGB as _eotf_sRGB,
        )
        import colour_checker_detection as _ccd
        _SETTINGS_DETECTION_COLORCHECKER_CLASSIC = getattr(
            _ccd, 'SETTINGS_DETECTION_COLORCHECKER_CLASSIC', None
        )
        _SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC = getattr(
            _ccd, 'SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC', None
        )
        _extractor_segmentation = getattr(_ccd, 'extractor_segmentation', None)
        _segmenter_default = getattr(_ccd, 'segmenter_default', None)

        if _SETTINGS_DETECTION_COLORCHECKER_CLASSIC is None:
            from colour_checker_detection import detection as _ccd_detection
            _SETTINGS_DETECTION_COLORCHECKER_CLASSIC = getattr(
                _ccd_detection, 'SETTINGS_DETECTION_COLORCHECKER_CLASSIC'
            )
        if _SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC is None:
            try:
                from colour_checker_detection.detection.common import (
                    SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC as _SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC,
                )
            except Exception:
                _SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC = None
        if _SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC is None:
            raise RuntimeError('SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC not found in colour_checker_detection')
        if _extractor_segmentation is None or _segmenter_default is None:
            from colour_checker_detection.detection.segmentation import (
                extractor_segmentation as _extractor_segmentation,
                segmenter_default as _segmenter_default,
            )
    except Exception as exc:
        raise RuntimeError(f'Failed to import colour pipeline dependencies: {exc}') from exc

    imageio = _imageio
    np = _np
    colour = _colour
    RGB_COLOURSPACES = _RGB_COLOURSPACES
    delta_E_CIE2000 = _delta_E_CIE2000
    RGB_to_XYZ = _RGB_to_XYZ
    XYZ_to_Lab = _XYZ_to_Lab
    Lab_to_XYZ = _Lab_to_XYZ
    XYZ_to_RGB = _XYZ_to_RGB
    eotf_inverse_sRGB = _eotf_inverse_sRGB
    eotf_sRGB = _eotf_sRGB
    SETTINGS_DETECTION_COLORCHECKER_CLASSIC = _SETTINGS_DETECTION_COLORCHECKER_CLASSIC
    SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC = _SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC
    extractor_segmentation = _extractor_segmentation
    segmenter_default = _segmenter_default
    RGB_SPACE = RGB_COLOURSPACES['sRGB']
    REFERENCE_SWATCHES = SETTINGS_DETECTION_COLORCHECKER_CLASSIC['reference_values']


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _get_storage_connection_string():
    connection = os.environ.get(STORAGE_CONNECTION_SETTING)
    if not connection:
        connection = os.environ.get('AzureWebJobsStorage')
    if not connection:
        raise ValueError('Storage connection string is not configured.')
    return connection


def _get_blob_service():
    return BlobServiceClient.from_connection_string(_get_storage_connection_string())


def _parse_connection_string(connection):
    parts = {}
    for item in connection.split(';'):
        if '=' in item:
            key, value = item.split('=', 1)
            parts[key] = value
    return parts


def _ensure_container(container_name):
    client = _get_blob_service().get_container_client(container_name)
    try:
        client.create_container()
    except ResourceExistsError:
        pass
    return client


def _job_blob_name(job_id):
    return f'{job_id}.json'


def _write_job_status(job_id, payload):
    container = _ensure_container(JOB_CONTAINER)
    blob = container.get_blob_client(_job_blob_name(job_id))
    blob.upload_blob(
        json.dumps(payload),
        overwrite=True,
        content_settings=ContentSettings(content_type='application/json')
    )


def _read_job_status(job_id):
    container = _get_blob_service().get_container_client(JOB_CONTAINER)
    blob = container.get_blob_client(_job_blob_name(job_id))
    try:
        data = blob.download_blob().readall()
    except ResourceNotFoundError:
        return None
    return json.loads(data)


def _generate_blob_sas_url(container, blob_name, permissions, expires_in_hours=1):
    connection = _get_storage_connection_string()
    parts = _parse_connection_string(connection)
    account_name = parts.get('AccountName')
    account_key = parts.get('AccountKey')
    if not account_name or not account_key:
        raise ValueError('AccountName or AccountKey missing in storage connection string.')
    sas = generate_blob_sas(
        account_name=account_name,
        container_name=container,
        blob_name=blob_name,
        account_key=account_key,
        permission=permissions,
        expiry=datetime.utcnow() + timedelta(hours=expires_in_hours)
    )
    return f'https://{account_name}.blob.core.windows.net/{container}/{blob_name}?{sas}'


def _decode_image_bytes(raw):
    _lazy_imports()
    image = imageio.imread(io.BytesIO(raw))
    if image.ndim == 2:
        image = np.stack([image] * 3, axis=-1)
    if image.shape[-1] == 4:
        image = image[:, :, :3]
    return image.astype(np.float32) / 255.0


def _decode_base64_image(data):
    if not data:
        raise ValueError('Missing image data.')
    if ',' in data:
        data = data.split(',', 1)[1]
    raw = base64.b64decode(data)
    return _decode_image_bytes(raw)


def _encode_image_bytes(image, fmt, quality):
    _lazy_imports()
    image = np.clip(image, 0.0, 1.0)
    image_uint8 = (image * 255.0 + 0.5).astype(np.uint8)
    buffer = io.BytesIO()
    if fmt == 'image/png':
        imageio.imwrite(buffer, image_uint8, format='png')
    else:
        imageio.imwrite(buffer, image_uint8, format='jpeg', quality=int(quality * 100))
    return buffer.getvalue()


def _encode_image(image, fmt, quality):
    return base64.b64encode(_encode_image_bytes(image, fmt, quality)).decode('ascii')


def _compute_delta_e(measured_swatches, reference_swatches):
    _lazy_imports()
    measured_xyz = RGB_to_XYZ(measured_swatches, RGB_SPACE)
    reference_xyz = RGB_to_XYZ(reference_swatches, RGB_SPACE)
    measured_lab = XYZ_to_Lab(measured_xyz, RGB_SPACE.whitepoint)
    reference_lab = XYZ_to_Lab(reference_xyz, RGB_SPACE.whitepoint)
    delta_e = delta_E_CIE2000(measured_lab, reference_lab)
    return delta_e


def _extract_swatches(image):
    _lazy_imports()
    settings = SETTINGS_SEGMENTATION_COLORCHECKER_CLASSIC.copy()
    attempts = []

    for working_width in (settings['working_width'], 2200):
        working_height = int(working_width * 4 / 6)
        tuned = {
            **settings,
            'working_width': working_width,
            'working_height': working_height,
        }
        attempts.append((False, True, tuned))
        attempts.append((True, True, tuned))

    tuned_loose = {
        **settings,
        'working_width': 2200,
        'working_height': int(2200 * 4 / 6),
        'swatch_minimum_area_factor': settings['swatch_minimum_area_factor'] * 3
    }
    attempts.append((False, True, tuned_loose))
    attempts.append((True, True, tuned_loose))

    for apply_cctf_encoding, apply_cctf_decoding, seg_settings in attempts:
        try:
            segmentation_data = segmenter_default(
                image,
                additional_data=True,
                apply_cctf_encoding=apply_cctf_encoding,
                **seg_settings
            )
            swatches_sets = extractor_segmentation(
                image,
                segmentation_data,
                apply_cctf_decoding=apply_cctf_decoding,
                additional_data=False,
                **seg_settings
            )
            if swatches_sets:
                return swatches_sets[0]
        except Exception:
            continue

    raise ValueError(
        'ColorCheckerを検出できませんでした。チャートが画面内に大きく写り、'
        'ピントが合い、反射や極端な傾きがないか確認してください。'
    )


def _apply_colour_correction(image, swatches, method):
    _lazy_imports()
    image_linear = eotf_sRGB(image)
    flat = image_linear.reshape(-1, 3)
    corrected = colour.colour_correction(
        flat,
        swatches,
        REFERENCE_SWATCHES,
        method=method
    )
    corrected = corrected.reshape(image_linear.shape)
    corrected = eotf_inverse_sRGB(np.clip(corrected, 0.0, 1.0))
    return corrected


def _evaluate_methods(swatches):
    _lazy_imports()
    scores = {}
    for method in METHODS:
        try:
            corrected = colour.colour_correction(
                swatches,
                swatches,
                REFERENCE_SWATCHES,
                method=method
            )
            delta_e = _compute_delta_e(corrected, REFERENCE_SWATCHES)
            scores[method] = float(np.mean(delta_e))
        except Exception:
            scores[method] = None

    valid = {k: v for k, v in scores.items() if v is not None}
    recommended = min(valid, key=valid.get) if valid else METHODS[0]
    return scores, recommended


def _apply_lab_shift(image, shift):
    _lazy_imports()
    if not shift:
        return image
    shift_l = float(shift.get('L', 0))
    shift_a = float(shift.get('a', 0))
    shift_b = float(shift.get('b', 0))
    if shift_l == 0 and shift_a == 0 and shift_b == 0:
        return image

    rgb_linear = eotf_sRGB(image)
    xyz = RGB_to_XYZ(rgb_linear, RGB_SPACE)
    lab = XYZ_to_Lab(xyz, RGB_SPACE.whitepoint)
    lab[..., 0] = np.clip(lab[..., 0] + shift_l, 0, 100)
    lab[..., 1] = np.clip(lab[..., 1] + shift_a, -128, 127)
    lab[..., 2] = np.clip(lab[..., 2] + shift_b, -128, 127)
    xyz2 = Lab_to_XYZ(lab, RGB_SPACE.whitepoint)
    rgb_linear2 = XYZ_to_RGB(xyz2, RGB_SPACE)
    rgb_linear2 = np.clip(rgb_linear2, 0.0, 1.0)
    return eotf_inverse_sRGB(rgb_linear2)


def _sanitize_filename(name):
    name = os.path.basename(name)
    name = name.replace(' ', '_')
    return ''.join(ch for ch in name if ch.isalnum() or ch in ('-', '_', '.'))


def _build_output_blob(job_id, fmt):
    ext = 'png' if fmt == 'image/png' else 'jpg'
    return f'{job_id}/result.{ext}'


@app.route(route='colorchecker/analyze', methods=['POST'], auth_level=func.AuthLevel.ANONYMOUS)
def colorchecker_analyze(req: func.HttpRequest) -> func.HttpResponse:
    try:
        _lazy_imports()
        payload = req.get_json()
        image = _decode_base64_image(payload.get('image'))
        swatches = _extract_swatches(image)
        delta_e = _compute_delta_e(swatches, REFERENCE_SWATCHES)
        method_scores, recommended_method = _evaluate_methods(swatches)
        swatches_xyz = RGB_to_XYZ(swatches, RGB_SPACE)
        swatches_lab = XYZ_to_Lab(swatches_xyz, RGB_SPACE.whitepoint)
        neutral = swatches_lab[18:24]
        neutral_mean = np.mean(neutral[:, 1:3], axis=0)
        neutral_std = np.std(neutral[:, 1:3], axis=0)
        neutral_shift = float(np.linalg.norm(neutral_mean))
        l_values = neutral[:, 0]
        l_min = float(np.min(l_values))
        l_max = float(np.max(l_values))

        score = 100.0
        score -= max(0.0, float(np.mean(delta_e)) - 2.0) * 4.0
        score -= neutral_shift * 2.5
        if l_max < 90:
          score -= (90 - l_max) * 0.5
        if l_min > 8:
          score -= (l_min - 8) * 0.5
        score = float(np.clip(score, 0, 100))
        response = {
            'deltaE': delta_e.tolist(),
            'deltaEAvg': float(np.mean(delta_e)),
            'deltaEMax': float(np.max(delta_e)),
            'swatches': swatches.tolist(),
            'methodScores': method_scores,
            'recommendedMethod': recommended_method,
            'neutralStats': {
                'meanA': float(neutral_mean[0]),
                'meanB': float(neutral_mean[1]),
                'stdA': float(neutral_std[0]),
                'stdB': float(neutral_std[1]),
                'lMin': l_min,
                'lMax': l_max
            },
            'qualityScore': score
        }
        return func.HttpResponse(json.dumps(response), mimetype='application/json')
    except Exception as exc:
        return func.HttpResponse(str(exc), status_code=400)


@app.route(route='colorchecker/correct', methods=['POST'], auth_level=func.AuthLevel.ANONYMOUS)
def colorchecker_correct(req: func.HttpRequest) -> func.HttpResponse:
    try:
        _lazy_imports()
        payload = req.get_json()
        image = _decode_base64_image(payload.get('image'))
        swatches = np.array(payload.get('swatches'), dtype=np.float32)
        method = payload.get('method') or 'Cheung 2004'
        fmt = payload.get('format') or 'image/jpeg'
        quality = float(payload.get('quality') or 0.92)
        spot_shift = payload.get('spotShift')

        if swatches.size == 0:
            raise ValueError('Calibration swatches are missing.')

        if method == 'auto':
            _, method = _evaluate_methods(swatches)
        corrected = _apply_colour_correction(image, swatches, method)
        corrected = _apply_lab_shift(corrected, spot_shift)
        encoded = _encode_image(corrected, fmt, quality)
        response = {
            'image': encoded,
            'methodUsed': method
        }
        return func.HttpResponse(json.dumps(response), mimetype='application/json')
    except Exception as exc:
        return func.HttpResponse(str(exc), status_code=400)


@app.route(route='jobs/sas', methods=['POST'], auth_level=func.AuthLevel.ANONYMOUS)
def jobs_sas(req: func.HttpRequest) -> func.HttpResponse:
    try:
        payload = req.get_json()
        filename = _sanitize_filename(payload.get('filename') or 'image.jpg')
        job_id = payload.get('jobId') or str(uuid.uuid4())
        blob_name = f'{job_id}/{filename}'

        _ensure_container(UPLOAD_CONTAINER)

        upload_url = _generate_blob_sas_url(
            UPLOAD_CONTAINER,
            blob_name,
            BlobSasPermissions(write=True, create=True),
            expires_in_hours=2
        )

        response = {
            'jobId': job_id,
            'uploadUrl': upload_url,
            'blobName': blob_name,
            'expiresAt': (datetime.utcnow() + timedelta(hours=2)).isoformat() + 'Z'
        }
        return func.HttpResponse(json.dumps(response), mimetype='application/json')
    except Exception as exc:
        return func.HttpResponse(str(exc), status_code=400)


@app.queue_output(arg_name='msg', queue_name=QUEUE_NAME, connection=STORAGE_CONNECTION_SETTING)
@app.route(route='jobs/submit', methods=['POST'], auth_level=func.AuthLevel.ANONYMOUS)
def jobs_submit(req: func.HttpRequest, msg: func.Out[str]) -> func.HttpResponse:
    try:
        _lazy_imports()
        payload = req.get_json()
        job_id = payload.get('jobId') or str(uuid.uuid4())
        input_blob = payload.get('inputBlob')
        swatches = payload.get('swatches')
        method = payload.get('method') or 'Cheung 2004'
        fmt = payload.get('format') or 'image/jpeg'
        quality = float(payload.get('quality') or 0.92)
        spot_shift = payload.get('spotShift')

        if not input_blob:
            raise ValueError('inputBlob is required.')
        if not swatches:
            raise ValueError('swatches is required.')

        output_blob = _build_output_blob(job_id, fmt)

        job_payload = {
            'jobId': job_id,
            'status': 'queued',
            'inputBlob': input_blob,
            'outputBlob': output_blob,
            'format': fmt,
            'quality': quality,
            'method': method,
            'updatedAt': _now_iso(),
            'createdAt': _now_iso()
        }
        _write_job_status(job_id, job_payload)

        queue_message = {
            'jobId': job_id,
            'inputBlob': input_blob,
            'outputBlob': output_blob,
            'format': fmt,
            'quality': quality,
            'method': method,
            'swatches': swatches,
            'spotShift': spot_shift
        }
        msg.set(json.dumps(queue_message))

        response = {
            'jobId': job_id,
            'status': 'queued'
        }
        return func.HttpResponse(json.dumps(response), mimetype='application/json')
    except Exception as exc:
        return func.HttpResponse(str(exc), status_code=400)


@app.route(route='jobs/status/{jobId}', methods=['GET'], auth_level=func.AuthLevel.ANONYMOUS)
def jobs_status(req: func.HttpRequest) -> func.HttpResponse:
    job_id = req.route_params.get('jobId')
    if not job_id:
        return func.HttpResponse('jobId is required.', status_code=400)
    job = _read_job_status(job_id)
    if not job:
        return func.HttpResponse('Job not found.', status_code=404)
    return func.HttpResponse(json.dumps(job), mimetype='application/json')


@app.route(route='jobs/result/{jobId}', methods=['GET'], auth_level=func.AuthLevel.ANONYMOUS)
def jobs_result(req: func.HttpRequest) -> func.HttpResponse:
    job_id = req.route_params.get('jobId')
    if not job_id:
        return func.HttpResponse('jobId is required.', status_code=400)
    job = _read_job_status(job_id)
    if not job:
        return func.HttpResponse('Job not found.', status_code=404)
    if job.get('status') != 'done':
        return func.HttpResponse('Job is not completed.', status_code=409)

    output_blob = job.get('outputBlob')
    if not output_blob:
        return func.HttpResponse('Output blob not found.', status_code=404)

    _ensure_container(OUTPUT_CONTAINER)
    download_url = _generate_blob_sas_url(
        OUTPUT_CONTAINER,
        output_blob,
        BlobSasPermissions(read=True),
        expires_in_hours=1
    )

    response = {
        'jobId': job_id,
        'downloadUrl': download_url,
        'outputBlob': output_blob
    }
    return func.HttpResponse(json.dumps(response), mimetype='application/json')


@app.queue_trigger(arg_name='msg', queue_name=QUEUE_NAME, connection=STORAGE_CONNECTION_SETTING)
def jobs_processor(msg: func.QueueMessage) -> None:
    _lazy_imports()
    payload = json.loads(msg.get_body().decode('utf-8'))
    job_id = payload.get('jobId')
    input_blob = payload.get('inputBlob')
    output_blob = payload.get('outputBlob')
    method = payload.get('method') or 'Cheung 2004'
    fmt = payload.get('format') or 'image/jpeg'
    quality = float(payload.get('quality') or 0.92)
    swatches = np.array(payload.get('swatches'), dtype=np.float32)
    spot_shift = payload.get('spotShift')

    if not job_id or not input_blob or not output_blob:
        raise ValueError('Queue payload is missing required fields.')

    blob_service = _get_blob_service()
    output_client = blob_service.get_blob_client(container=OUTPUT_CONTAINER, blob=output_blob)
    try:
        output_client.get_blob_properties()
        return
    except ResourceNotFoundError:
        pass

    job_status = _read_job_status(job_id) or {}
    job_status.update({
        'jobId': job_id,
        'status': 'processing',
        'updatedAt': _now_iso()
    })
    _write_job_status(job_id, job_status)

    try:
        input_client = blob_service.get_blob_client(container=UPLOAD_CONTAINER, blob=input_blob)
        raw = input_client.download_blob().readall()
        image = _decode_image_bytes(raw)

        if method == 'auto':
            _, method = _evaluate_methods(swatches)
        corrected = _apply_colour_correction(image, swatches, method)
        corrected = _apply_lab_shift(corrected, spot_shift)
        encoded = _encode_image_bytes(corrected, fmt, quality)

        _ensure_container(OUTPUT_CONTAINER)
        output_client.upload_blob(
            encoded,
            overwrite=True,
            content_settings=ContentSettings(content_type=fmt)
        )

        job_status.update({
            'status': 'done',
            'outputBlob': output_blob,
            'methodUsed': method,
            'updatedAt': _now_iso()
        })
        _write_job_status(job_id, job_status)
    except Exception as exc:
        job_status.update({
            'status': 'error',
            'error': str(exc),
            'updatedAt': _now_iso()
        })
        _write_job_status(job_id, job_status)
        raise
