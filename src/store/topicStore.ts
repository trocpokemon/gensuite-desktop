import { create } from 'zustand';
import type { TopicConfig } from '../shared/types';
import { uid } from './projectStore';

export const DEFAULT_TOPICS: TopicConfig[] = [
  {
    id: 'health', name: 'Sức khỏe', source: 'system', thumbnail: '/topic-thumbnails/health.svg', defaultTone: 'Ấm áp, đáng tin cậy',
    description: 'Kiến thức sức khỏe dễ hiểu, thực tế và có trách nhiệm.', targetAudience: 'Người trưởng thành quan tâm sức khỏe', defaultWordCount: 1500,
    visualStyle: 'Clean documentary photography, natural light, realistic, trustworthy, consistent color palette',
    negativePrompt: 'graphic medical imagery, fearmongering, text, watermark',
    masterPrompt: 'Bạn là biên tập viên nội dung sức khỏe giàu kinh nghiệm. Viết bằng tiếng Việt tự nhiên, dễ nghe khi đọc thành tiếng. Giải thích rõ ràng, không giật gân, không chẩn đoán cá nhân và luôn nhắc người xem tham khảo chuyên gia khi phù hợp. Nội dung phải liền mạch như một chương sách, không liệt kê phân cảnh hay hướng dẫn quay.',
  },
  {
    id: 'bible', name: 'Kinh Thánh', source: 'system', thumbnail: '/topic-thumbnails/bible.svg', defaultTone: 'Trang trọng, truyền cảm',
    description: 'Suy ngẫm và kể chuyện Kinh Thánh gần gũi.', targetAudience: 'Khán giả yêu thích nội dung Cơ Đốc', defaultWordCount: 1800,
    visualStyle: 'Cinematic biblical era, warm golden light, reverent atmosphere, historically inspired clothing, consistent characters',
    negativePrompt: 'modern objects, text, watermark, inconsistent faces',
    masterPrompt: 'Bạn là người kể chuyện và biên tập nội dung Kinh Thánh. Hãy viết một bài kể liền mạch, trang trọng nhưng gần gũi, giàu suy ngẫm và phù hợp để đọc thành tiếng. Không chia cảnh, không ghi thời gian, không đưa chỉ dẫn sản xuất.',
  },
  {
    id: 'buddhism', name: 'Phật pháp', source: 'system', thumbnail: '/topic-thumbnails/buddhism.svg', defaultTone: 'Điềm tĩnh, chiêm nghiệm',
    description: 'Câu chuyện và bài học Phật pháp ứng dụng trong đời sống.', targetAudience: 'Người tìm kiếm sự bình an và tỉnh thức', defaultWordCount: 1800,
    visualStyle: 'Serene cinematic Asian landscape, soft morning light, contemplative, elegant, consistent earth tones',
    negativePrompt: 'commercial logos, text, watermark, exaggerated fantasy',
    masterPrompt: 'Bạn là người kể chuyện Phật pháp bằng ngôn ngữ đời thường, điềm tĩnh và sâu sắc. Viết nội dung liên tục như một bài đọc hoặc truyện kể, kết nối bài học với đời sống. Không chia phân cảnh, không liệt kê máy móc, không đưa chỉ dẫn hình ảnh.',
  },
  {
    id: 'drama', name: 'Drama tình cảm', source: 'system', thumbnail: '/topic-thumbnails/drama.svg', defaultTone: 'Kịch tính, giàu cảm xúc',
    description: 'Truyện tình cảm có cao trào và giữ chân người xem.', targetAudience: 'Khán giả yêu thích truyện tâm lý tình cảm', defaultWordCount: 2500,
    visualStyle: 'Cinematic contemporary Vietnamese drama, emotional lighting, realistic faces, consistent wardrobe and characters',
    negativePrompt: 'different faces for same character, text, watermark, distorted hands',
    masterPrompt: 'Bạn là nhà văn chuyên truyện drama tình cảm cho YouTube. Viết thành một câu chuyện liền mạch, có mở đầu thu hút, xung đột tăng dần, cao trào và kết thúc thỏa đáng. Văn bản phải tự nhiên khi đọc thành tiếng. Không đánh số, không chia cảnh, không ghi thời lượng hoặc chỉ dẫn sản xuất.',
  },
];

interface TopicStore {
  topics: TopicConfig[];
  loaded: boolean;
  load: () => Promise<void>;
  saveTopic: (topic: TopicConfig) => Promise<void>;
  removeTopic: (id: string) => Promise<void>;
  cloneTopic: (topic: TopicConfig) => Promise<TopicConfig>;
}

export const useTopicStore = create<TopicStore>((set, get) => ({
  topics: DEFAULT_TOPICS,
  loaded: false,
  load: async () => {
    const custom = await window.gensuite?.topics.load().catch(() => []) ?? [];
    set({ topics: [...DEFAULT_TOPICS, ...custom], loaded: true });
  },
  saveTopic: async (topic) => {
    const next = [...get().topics.filter((item) => item.id !== topic.id), { ...topic, source: 'user' as const }];
    const custom = next.filter((item) => item.source === 'user');
    await window.gensuite.topics.save(custom);
    set({ topics: [...DEFAULT_TOPICS, ...custom] });
  },
  removeTopic: async (id) => {
    const custom = get().topics.filter((item) => item.source === 'user' && item.id !== id);
    await window.gensuite.topics.save(custom);
    set({ topics: [...DEFAULT_TOPICS, ...custom] });
  },
  cloneTopic: async (topic) => {
    const clone = { ...topic, id: uid('topic_'), name: `${topic.name} tùy chỉnh`, source: 'user' as const };
    await get().saveTopic(clone);
    return clone;
  },
}));
