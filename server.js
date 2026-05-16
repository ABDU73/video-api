import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:youtube_explode_dart/youtube_explode_dart.dart';

class VideoService {
  final YoutubeExplode _yt = YoutubeExplode();
  YoutubeExplode get yt => _yt;

  static const String _serverBase = 'https://video-api-hqct.onrender.com';

  // ------------------------------------------------------------
  // 1) SEARCH
  // ------------------------------------------------------------
  Future<VideoSearchList> searchFirstPage(String query) async {
    return await _yt.search.search(query, filter: TypeFilters.video);
  }

  // ------------------------------------------------------------
  // 2) PLAYBACK URL (server first, 720p)
  // ------------------------------------------------------------
  Future<String?> getPlayUrl(String youtubeUrl) async {
    final uri = Uri.parse('$_serverBase/play?url=${Uri.encodeComponent(youtubeUrl)}');
    try {
      final response = await http.get(uri).timeout(const Duration(seconds: 10));
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        final url = data['url'] as String?;
        if (url != null && url.isNotEmpty) return url;
      }
    } catch (_) {}

    // fallback on‑device
    try {
      final videoId = _extractVideoId(youtubeUrl);
      if (videoId == null) return null;
      final manifest = await _yt.videos.streamsClient.getManifest(videoId);
      final stream = manifest.muxed.withHighestBitrate();
      return stream?.url.toString();
    } catch (_) {}
    return null;
  }

  // ------------------------------------------------------------
  // 3) QUICK DOWNLOAD (server 480p, with size check)
  // ------------------------------------------------------------
  Future<String?> getDirectUrl(String youtubeUrl) async {
    // Try server default (480p)
    final uri = Uri.parse('$_serverBase/get?url=${Uri.encodeComponent(youtubeUrl)}');
    try {
      final response = await http.get(uri).timeout(const Duration(seconds: 10));
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        final url = data['url'] as String?;
        if (url != null && url.isNotEmpty) {
          // Verify size (skip tiny files)
          final headResp = await http.head(Uri.parse(url))
              .timeout(const Duration(seconds: 5));
          final contentLength = int.tryParse(headResp.headers['content-length'] ?? '');
          if (contentLength != null && contentLength > 2 * 1024 * 1024) {
            return url;
          }
        }
      }
    } catch (_) {}

    // Fallback on‑device 480p
    try {
      final videoId = _extractVideoId(youtubeUrl);
      if (videoId == null) return null;
      final manifest = await _yt.videos.streamsClient.getManifest(videoId);
      final stream = manifest.muxed
          .where((s) => (s.videoResolution?.height ?? 0) <= 480)
          .withHighestBitrate();
      final selected = stream ?? manifest.muxed.withHighestBitrate();
      return selected?.url.toString();
    } catch (_) {}
    return null;
  }

  // ------------------------------------------------------------
  // 4) AVAILABLE QUALITIES (on‑device, instant)
  // ------------------------------------------------------------
  Future<List<Map<String, dynamic>>> getAvailableQualities(String youtubeUrl) async {
    final videoId = _extractVideoId(youtubeUrl);
    if (videoId == null) return [];

    try {
      final manifest = await _yt.videos.streamsClient.getManifest(videoId);
      final streams = manifest.muxed.toList();

      final seen = <int>{};
      final qualities = <Map<String, dynamic>>[];

      for (final s in streams) {
        final height = s.videoResolution?.height ?? 0;
        if (height == 0 || seen.contains(height)) continue;
        seen.add(height);

        qualities.add({
          'height': height,
          'label': '${height}p',
          'url': s.url.toString(),
          'size': s.size.totalBytes,
        });
      }

      qualities.sort((a, b) => (b['height'] as int).compareTo(a['height']));
      return qualities;
    } catch (_) {
      return [];
    }
  }

  // ------------------------------------------------------------
  // 5) DOWNLOAD SPECIFIC QUALITY VIA SERVER (with caching)
  // ------------------------------------------------------------
  Future<String?> getServerDirectUrlForQuality(String youtubeUrl, int height) async {
    final uri = Uri.parse('$_serverBase/get?url=${Uri.encodeComponent(youtubeUrl)}&q=$height');
    try {
      final response = await http.get(uri).timeout(const Duration(seconds: 10));
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        final url = data['url'] as String?;
        if (url != null && url.isNotEmpty) return url;
      }
    } catch (_) {}
    // Fallback to on‑device extraction for that height
    try {
      final videoId = _extractVideoId(youtubeUrl);
      if (videoId == null) return null;
      final manifest = await _yt.videos.streamsClient.getManifest(videoId);
      final stream = manifest.muxed
          .where((s) => (s.videoResolution?.height ?? 0) == height)
          .withHighestBitrate();
      return stream?.url.toString();
    } catch (_) {}
    return null;
  }

  // ------------------------------------------------------------
  // 6) FULL VIDEO INFO (metadata + quick download URL)
  // ------------------------------------------------------------
  Future<Map<String, dynamic>?> getVideoInfo(String youtubeUrl) async {
    try {
      final videoId = _extractVideoId(youtubeUrl);
      if (videoId == null) return null;

      final video = await _yt.videos.get(VideoId(videoId));
      final downloadUrl = await getDirectUrl(youtubeUrl);

      return {
        'videoId': video.id.value,
        'title': video.title,
        'author': video.author,
        'thumbnail': video.thumbnails.highResUrl ??
            video.thumbnails.mediumResUrl ??
            video.thumbnails.lowResUrl,
        'duration': video.duration?.toString() ?? 'Unknown',
        'downloadUrl': downloadUrl,
      };
    } catch (_) {
      return null;
    }
  }

  String? _extractVideoId(String url) {
    final match = RegExp(
      r'(?:youtube\.com\/.*[?&]v=|youtu\.be\/)([a-zA-Z0-9_-]{11})',
    ).firstMatch(url);
    return match?.group(1);
  }

  void dispose() => _yt.close();
}
