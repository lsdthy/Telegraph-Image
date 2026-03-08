import { errorHandling, telemetryData } from "./utils/middleware";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();
        
        // 判断是否为图片类型
        const isImage = uploadFile.type.startsWith('image/');

        const uploadTasks = [];

        if (isImage) {
            // 图片上传任务 1：使用 sendPhoto 上传（Telegram 自动压缩，进入"媒体"相册，方便批量滑动查看）
            const photoFormData = new FormData();
            photoFormData.append("chat_id", env.TG_Chat_ID);
            photoFormData.append("photo", uploadFile);
            uploadTasks.push(uploadToTelegram(photoFormData, 'sendPhoto', env));

            // 图片上传任务 2：使用 sendDocument 上传（保留原图无损大小，进入"文件"栏，最大支持 50MB）
            const docFormData = new FormData();
            docFormData.append("chat_id", env.TG_Chat_ID);
            docFormData.append("document", uploadFile);
            uploadTasks.push(uploadToTelegram(docFormData, 'sendDocument', env));
        } else {
            // 保持原有非图片类型（如视频、音频、常规文件）的上传逻辑
            const otherFormData = new FormData();
            otherFormData.append("chat_id", env.TG_Chat_ID);
            let endpoint = 'sendDocument';
            
            if (uploadFile.type.startsWith('video/')) {
                otherFormData.append("video", uploadFile);
                endpoint = 'sendVideo';
            } else if (uploadFile.type.startsWith('audio/')) {
                otherFormData.append("audio", uploadFile);
                endpoint = 'sendAudio';
            } else {
                otherFormData.append("document", uploadFile);
            }
            uploadTasks.push(uploadToTelegram(otherFormData, endpoint, env));
        }

        // 并发执行所有上传任务，避免时间翻倍
        const results = await Promise.all(uploadTasks);
        const responseDataArray = [];

        for (const result of results) {
            const fileId = getFileId(result.responseData, result.endpoint);
            if (!fileId) {
                throw new Error(`Failed to get file ID for ${result.endpoint}`);
            }

            // 区分原图和压缩图的名称标识（方便在 KV 数据库/后台管理中区分）
            let labelPrefix = "";
            if (isImage && results.length > 1) {
                labelPrefix = result.endpoint === 'sendDocument' ? "[原图] " : "[预览图] ";
            }

            // 将文件信息保存到 KV 存储
            if (env.img_url) {
                await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                    metadata: {
                        TimeStamp: Date.now(),
                        ListType: "None",
                        Label: "None",
                        liked: false,
                        fileName: `${labelPrefix}${fileName}`,
                        fileSize: uploadFile.size,
                    }
                });
            }

            // 将生成的链接加入返回数组
            responseDataArray.push({ 'src': `/file/${fileId}.${fileExtension}` });
        }

        // 如果只有一张图，直接返回第一张（向下兼容一些没适配多图片的旧版客户端）
        // 如果是多链接（即原图+压缩图），前端也能完美批量解析渲染出来
        return new Response(
            JSON.stringify(responseDataArray),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

// ================= 辅助函数部分 =================

// 封装：向 Telegram 发送请求
async function uploadToTelegram(formData, endpoint, env) {
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${endpoint}`;
    console.log(`Sending request to: ${apiUrl}`);

    const response = await fetch(apiUrl, {
        method: "POST",
        body: formData
    });

    const responseData = await response.json();

    if (!response.ok) {
        console.error(`Error response from Telegram API (${endpoint}):`, responseData);
        throw new Error(responseData.description || `Upload to Telegram failed via ${endpoint}`);
    }

    return { responseData, endpoint };
}

// 封装：根据不同的 Telegram 接口返回结构，提取正确的 file_id
function getFileId(response, endpoint) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    
    // 如果是 sendPhoto，取体积最大的一张（最佳画质的压缩图）
    if (endpoint === 'sendPhoto' && result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    } 
    // 文档、视频、音频的 file_id 提取
    else if (endpoint === 'sendDocument' && result.document) {
        return result.document.file_id;
    } else if (endpoint === 'sendVideo' && result.video) {
        return result.video.file_id;
    } else if (endpoint === 'sendAudio' && result.audio) {
        return result.audio.file_id;
    }

    return null;
}
