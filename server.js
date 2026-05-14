import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:youtube_explode_dart/youtube_explode_dart.dart';

class VideoService {
  final YoutubeExplode _yt = YoutubeExplode();

  // Your Render server (already optimised)
  static const String _serverBase = 'https://video-api-hqct.onrender.com';

  // ------------------------------------------------------------
  // 1) SEARCH (on‑device, no API key, no server)
  // ------------------------------------------------------------
  Future<Map<String, dynamic>> search(String query,
      {String? pageToken}) async {
    try {
      final searchResults = await _yt.search.search(
        query,
        filter: TypeFilters.video,
        pageToken: pageToken,
      );
      final videos = searchResults.items.map((video) {
        return {
          'videoId': video.id.value,
          'title': video.title,
          'author': video.author,
          'thumbnail': video.thumbnails.highResUrl ??
              video.thumbnails.mediumResUrl ??
              video.thumbnails.lowResUrl,
          'duration': video.duration?.toString() ?? 'Unknown',
        };
      }).toList();
      return {
        'videos': videos,
        'nextPageToken': searchResults.nextPageToken,
      };
    } catch (e) {
      return {'videos': [], 'nextPageToken': null};
    }
  }

  // ------------------------------------------------------------
  // 2) DOWNLOAD URL + METADATA (fast Render server)
  // ------------------------------------------------------------
  Future<Map<String, dynamic>?> getVideoInfo(String youtubeUrl) async {
    try {
      final uri = Uri.parse(
        '$_serverBase/get?url=${Uri.encodeComponent(youtubeUrl)}',
      );
      final response = await http.get(uri)
          .timeout(const Duration(seconds: 8));
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        final directUrl = data['url'] as String?;
        if (directUrl != null && directUrl.isNotEmpty) {
          // Fetch metadata from youtube_explode_dart (lightweight)
          final videoId = _extractVideoId(youtubeUrl);
          if (videoId != null) {
            final video = await _yt.videos.get(VideoId(videoId));
            return {
              'title': video.title,
              'author': video.author,
              'thumbnail': video.thumbnails.highResUrl ??
                  video.thumbnails.mediumResUrl ??
                  video.thumbnails.lowResUrl,
              'duration': video.duration?.toString() ?? 'Unknown',
              'downloadUrl': directUrl,
            };
          }
          return {'downloadUrl': directUrl};
        }
      }
    } catch (_) {}
    return null;
  }

  /// Quick helper – just returns the download URL
  Future<String?> getDirectUrl(String youtubeUrl) async {
    final info = await getVideoInfo(youtubeUrl);
    return info?['downloadUrl']?.toString();
  }

  String? _extractVideoId(String url) {
    final match = RegExp(
      r'(?:youtube\.com\/.*[?&]v=|youtu\.be\/)([a-zA-Z0-9_-]{11})',
    ).firstMatch(url);
    return match?.group(1);
  }

  void dispose() => _yt.close();
}
