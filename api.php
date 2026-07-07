<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit(0); }

define('SECRET',     '159');
define('DATA_FILE',  __DIR__ . '/data.json');
define('PHOTOS_DIR', __DIR__ . '/photos/');
define('PHOTOS_URL', 'photos/');

// ── GET: devuelve todos los datos ─────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo file_exists(DATA_FILE) ? file_get_contents(DATA_FILE) : '{}';
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// ── POST: datos JSON ──────────────────────────────────────────────────────────
$body = json_decode(file_get_contents('php://input'), true);

if (!$body || ($body['key'] ?? '') !== SECRET) {
    http_response_code(403);
    echo json_encode(['error' => 'No autorizado']);
    exit;
}

$action = $body['action'] ?? 'save';

if ($action === 'save') {
    $data = $body['data'] ?? [];
    $ok   = file_put_contents(DATA_FILE, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    echo $ok !== false ? json_encode(['ok' => true]) : json_encode(['error' => 'Error al guardar']);
    exit;
}

if ($action === 'upload_photo') {
    $base64    = preg_replace('/^data:image\/\w+;base64,/', '', $body['imageData'] ?? '');
    $imageData = base64_decode($base64);
    if (!$imageData) { http_response_code(400); echo json_encode(['error' => 'Imagen inválida']); exit; }
    if (!is_dir(PHOTOS_DIR)) mkdir(PHOTOS_DIR, 0755, true);
    $id   = preg_replace('/[^a-z0-9\-_]/', '', $body['id'] ?? 'photo');
    foreach (['jpg','jpeg','png','webp'] as $e) { $f = PHOTOS_DIR.$id.'.'.$e; if(file_exists($f)) unlink($f); }
    $dest = PHOTOS_DIR . $id . '.jpg';
    if (file_put_contents($dest, $imageData) === false) { http_response_code(500); echo json_encode(['error' => 'Error al guardar']); exit; }
    echo json_encode(['url' => PHOTOS_URL . $id . '.jpg?v=' . time()]);
    exit;
}

if ($action === 'delete_photo') {
    $id = preg_replace('/[^a-z0-9\-_]/', '', $body['id'] ?? '');
    foreach (['jpg', 'jpeg', 'png', 'webp'] as $ext) {
        $f = PHOTOS_DIR . $id . '.' . $ext;
        if (file_exists($f)) { unlink($f); break; }
    }
    echo json_encode(['ok' => true]);
    exit;
}

http_response_code(400);
echo json_encode(['error' => 'Acción no reconocida']);
