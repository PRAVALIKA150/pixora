(function () {
    'use strict';

    // ---------- State ----------
    const state = {
        user: null,
        bio: '',
        avatar: null,
        theme: localStorage.getItem('pixora_theme') || 'light',
        view: 'home',
        images: [],
        saved: JSON.parse(localStorage.getItem('pixora_saved') || '[]'),
        analytics: null,
        explore: null,
        profile: null,
        searchQuery: '',
        uploadProgress: 0,
        isUploading: false
    };

    const routes = ['home', 'explore', 'upload', 'analytics', 'profile', 'settings'];
    const protectedRoutes = ['upload', 'analytics', 'profile', 'settings'];

    // ---------- Helpers ----------
    function $(sel, el) { return (el || document).querySelector(sel); }
    function $$(sel, el) { return Array.from((el || document).querySelectorAll(sel)); }

    function escapeHtml(text) {
        if (text == null) return '';
        const d = document.createElement('div');
        d.textContent = text;
        return d.innerHTML;
    }

    function initials(name) {
        return (name || '?')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map(p => p[0].toUpperCase())
            .join('') || '?';
    }

    function formatSize(bytes) {
        if (bytes == null) return '';
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        const val = bytes / Math.pow(1024, i);
        return val.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    }

    function timeAgo(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const now = new Date();
        const seconds = Math.floor((now - date) / 1000);
        const intervals = [
            { label: 'year', seconds: 31536000 },
            { label: 'month', seconds: 2592000 },
            { label: 'week', seconds: 604800 },
            { label: 'day', seconds: 86400 },
            { label: 'hour', seconds: 3600 },
            { label: 'minute', seconds: 60 }
        ];
        for (const interval of intervals) {
            const count = Math.floor(seconds / interval.seconds);
            if (count >= 1) return `${count} ${interval.label}${count > 1 ? 's' : ''} ago`;
        }
        return 'Just now';
    }

    function avatarHtml(name, avatar, size) {
        if (avatar) {
            return `<img src="/avatar/${encodeURIComponent(avatar)}" alt="${escapeHtml(name)}" class="avatar ${size || ''}">`;
        }
        return `<div class="avatar ${size || ''}">${escapeHtml(initials(name))}</div>`;
    }

    // ---------- Toast ----------
    function showToast(message, type) {
        const container = $('#toastContainer');
        const toast = document.createElement('div');
        toast.className = 'toast ' + (type || 'info');
        toast.innerHTML = `<span>${escapeHtml(message)}</span><button class="toast-close">×</button>`;
        container.appendChild(toast);

        toast.querySelector('.toast-close').addEventListener('click', () => {
            toast.classList.add('hide');
            setTimeout(() => toast.remove(), 200);
        });

        setTimeout(() => {
            toast.classList.add('hide');
            setTimeout(() => toast.remove(), 200);
        }, 4000);
    }

    // ---------- Theme ----------
    function applyTheme() {
        document.documentElement.setAttribute('data-theme', state.theme);
        localStorage.setItem('pixora_theme', state.theme);
    }

    function toggleTheme() {
        state.theme = state.theme === 'light' ? 'dark' : 'light';
        applyTheme();
    }

    // ---------- API ----------
    async function api(url, options) {
        const res = await fetch(url, { ...options, credentials: 'include' });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const msg = data?.message || `HTTP ${res.status}`;
            throw new Error(msg);
        }
        return data;
    }

    async function getMe() {
        return api('/api/auth/me', { method: 'GET' });
    }

    async function signUp(username, email, password, bio) {
        return api('/api/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password, bio })
        });
    }

    async function signIn(username, password) {
        return api('/api/auth/signin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
    }

    async function signOut() {
        return api('/api/auth/signout', { method: 'POST' });
    }

    async function loadImages() {
        const data = await api('/api/images', { method: 'GET' });
        state.images = data.images || [];
        return state.images;
    }

    async function loadAnalytics() {
        const data = await api('/api/analytics', { method: 'GET' });
        state.analytics = data.analytics;
        return data.analytics;
    }

    async function loadExplore() {
        const data = await api('/api/explore', { method: 'GET' });
        state.explore = data.explore;
        return data.explore;
    }

    async function loadProfile(user) {
        const target = user || state.user?.username || 'anonymous';
        const data = await api('/api/users/' + encodeURIComponent(target) + '/stats', { method: 'GET' });
        state.profile = data.profile;
        return data.profile;
    }

    async function searchImages(query) {
        const data = await api('/api/search?q=' + encodeURIComponent(query), { method: 'GET' });
        state.images = data.images || [];
        return state.images;
    }

    async function toggleLike(id) {
        const image = state.images.find(i => i.id === id);
        if (!image) return;

        const isLiked = !image.isLiked;
        const action = isLiked ? 'like' : 'unlike';

        // Optimistic update
        image.isLiked = isLiked;
        image.likeCount = Math.max(0, image.likeCount + (isLiked ? 1 : -1));
        updatePostLikeUI(id, image.isLiked, image.likeCount);

        try {
            await api(`/api/images/${id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        } catch (err) {
            // Revert
            image.isLiked = !isLiked;
            image.likeCount = Math.max(0, image.likeCount + (isLiked ? -1 : 1));
            updatePostLikeUI(id, image.isLiked, image.likeCount);
            showToast(err.message, 'error');
        }
    }

    async function submitComment(id, text) {
        const data = await api(`/api/images/${id}/comment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
        });

        const image = state.images.find(i => i.id === id);
        if (image) {
            image.commentCount = (image.commentCount || 0) + 1;
            updatePostCommentUI(id, image.commentCount);
        }

        return data.comment;
    }

    async function deleteComment(commentId, imageId) {
        await api('/api/comments/' + commentId, { method: 'DELETE' });
        const image = state.images.find(i => i.id === imageId);
        if (image) {
            image.commentCount = Math.max(0, (image.commentCount || 0) - 1);
            updatePostCommentUI(imageId, image.commentCount);
        }
        await loadComments(imageId);
    }

    async function loadComments(id) {
        const data = await api(`/api/images/${id}/comments`, { method: 'GET' });
        const list = $('#comments-' + id);
        if (!list) return;

        list.innerHTML = data.comments && data.comments.length
            ? data.comments.map(c => commentHtml(c, id)).join('')
            : `<div class="comments-empty" style="padding:8px 0;color:var(--text-tertiary);font-size:13px">No comments yet</div>`;

        $$('.comment-delete').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const cid = parseInt(btn.dataset.id, 10);
                const iid = parseInt(btn.dataset.image, 10);
                if (confirm('Delete this comment?')) {
                    deleteComment(cid, iid).catch(err => showToast(err.message, 'error'));
                }
            });
        });
    }

    async function updateProfile(bio) {
        return api('/api/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bio })
        });
    }

    async function changePassword(currentPassword, newPassword) {
        return api('/api/account/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword })
        });
    }

    async function deleteAccount() {
        return api('/api/account', { method: 'DELETE' });
    }

    async function deleteImage(blobName) {
        const data = await api('/delete/' + encodeURIComponent(blobName), { method: 'DELETE' });
        showToast(data.message, 'success');
        await renderHome();
    }

    // ---------- UI Updates ----------
    function updatePostLikeUI(id, isLiked, count) {
        const btn = $(`#like-btn-${id}`);
        if (btn) {
            btn.classList.toggle('liked', isLiked);
            btn.innerHTML = heartIcon(isLiked) + `<span>${count}</span>`;
        }
        const likesEl = $(`#likes-${id}`);
        if (likesEl) likesEl.textContent = `${count} ${count === 1 ? 'like' : 'likes'}`;
    }

    function updatePostCommentUI(id, count) {
        const btn = $(`#comment-btn-${id}`);
        if (btn) btn.innerHTML = commentIcon() + `<span>${count}</span>`;

        const preview = $(`#comments-count-${id}`);
        if (preview) {
            preview.textContent = count > 0 ? `View all ${count} comments` : '';
            preview.style.display = count > 0 ? 'block' : 'none';
        }
    }

    // ---------- Icons ----------
    function heartIcon(liked) {
        if (liked) {
            return '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
        }
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>';
    }

    function commentIcon() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';
    }

    function shareIcon() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>';
    }

    function bookmarkIcon(saved) {
        if (saved) {
            return '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>';
        }
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>';
    }

    function trashIcon() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
    }

    // ---------- Components ----------
    function postCardHtml(image) {
        const encoded = encodeURIComponent(image.blobName);
        const safeName = escapeHtml(image.fileName);
        const uploader = escapeHtml(image.uploader || 'Anonymous');
        const caption = escapeHtml(image.caption || '');
        const tags = image.tags || [];
        const isSaved = image.id ? state.saved.includes(image.id) : false;
        const hasId = !!image.id;
        const isOwner = state.user && image.uploader === state.user.username;
        const canInteract = !!state.user && hasId;

        const socialActions = canInteract ? `
            <button class="action-btn ${image.isLiked ? 'liked' : ''}" id="like-btn-${image.id}" onclick="pixora.toggleLike(${image.id})" aria-label="Like" title="Like">
                ${heartIcon(image.isLiked)}<span>${image.likeCount}</span>
            </button>
            <button class="action-btn" id="comment-btn-${image.id}" onclick="pixora.openComments(${image.id})" aria-label="Comment" title="Comment">
                ${commentIcon()}<span>${image.commentCount}</span>
            </button>
            <button class="action-btn" onclick="pixora.sharePost('${encoded}', '${escapeHtml(safeName)}')" aria-label="Share" title="Share">
                ${shareIcon()}
            </button>
        ` : `
            <button class="action-btn" disabled title="Sign in to like" style="opacity:.5;cursor:not-allowed" aria-label="Like">
                ${heartIcon(false)}<span>${image.likeCount}</span>
            </button>
            <button class="action-btn" disabled title="Sign in to comment" style="opacity:.5;cursor:not-allowed" aria-label="Comment">
                ${commentIcon()}<span>${image.commentCount}</span>
            </button>
            <button class="action-btn" onclick="pixora.sharePost('${encoded}', '${escapeHtml(safeName)}')" aria-label="Share" title="Share">
                ${shareIcon()}
            </button>
        `;

        return `
        <article class="post-card" data-id="${image.id || image.blobName}">
            <div class="post-header">
                <div class="post-author">
                    ${avatarHtml(uploader, image.avatar)}
                    <div class="post-author-info">
                        <a href="/profile/${uploader}" class="post-author-name" data-user="${uploader}">${uploader}</a>
                        <span class="post-date">${timeAgo(image.uploadTime)}</span>
                    </div>
                </div>
                ${isOwner ? `<button class="post-delete" onclick="pixora.deletePost('${encoded}')" aria-label="Delete post" title="Delete">${trashIcon()}</button>` : ''}
            </div>
            <div class="post-image">
                <img src="/image/${encoded}" alt="${safeName}" loading="lazy">
            </div>
            <div class="post-actions">
                <div class="post-actions-left">
                    ${socialActions}
                </div>
                ${hasId ? `<button class="action-btn ${isSaved ? 'saved' : ''}" id="save-btn-${image.id}" onclick="pixora.toggleSave(${image.id})" aria-label="Save" title="Save">${bookmarkIcon(isSaved)}</button>` : ''}
            </div>
            <div class="post-body">
                ${hasId ? `<div class="likes-count" id="likes-${image.id}">${image.likeCount} ${image.likeCount === 1 ? 'like' : 'likes'}</div>` : ''}
                ${caption ? `<div class="caption"><a href="/profile/${uploader}" class="author-name" data-user="${uploader}">${uploader}</a>${caption}</div>` : ''}
                ${tags.length ? `<div class="tags-row">${tags.map(t => `<span class="tag-pill" onclick="pixora.searchTag('${escapeHtml(t)}')">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                ${hasId && image.commentCount > 0 ? `<div class="comments-preview" id="comments-count-${image.id}" onclick="pixora.openComments(${image.id})">View all ${image.commentCount} comments</div>` : ''}
                ${hasId ? `<div class="comments-section" id="comments-section-${image.id}">
                    <div class="comments-list" id="comments-${image.id}"></div>
                    ${canInteract ? `<div class="comment-input-wrap">
                        ${avatarHtml(state.user?.username, state.avatar, 'avatar-sm')}
                        <input type="text" id="comment-input-${image.id}" placeholder="Add a comment..." maxlength="500" aria-label="Add a comment">
                        <button onclick="pixora.postComment(${image.id})" aria-label="Post comment">Post</button>
                    </div>` : `<div class="sign-in-prompt" style="padding:10px 0;font-size:13px;color:var(--text-tertiary)"><a href="#" onclick="pixora.navigate('auth');return false">Sign in</a> to comment</div>`}
                </div>` : ''}
            </div>
        </article>
        `;
    }

    function commentHtml(comment, imageId) {
        const isOwner = state.user && comment.Uploader === state.user.username;
        return `
        <div class="comment-item">
            ${avatarHtml(comment.Uploader, null, 'avatar-sm')}
            <div class="comment-body">
                <div class="comment-author">${escapeHtml(comment.Uploader)}</div>
                <div class="comment-text">${escapeHtml(comment.CommentText)}</div>
                <div class="comment-time">${timeAgo(comment.CreatedAt)}</div>
            </div>
            ${isOwner ? `<button class="comment-delete" data-id="${comment.Id}" data-image="${imageId}" title="Delete">${trashIcon()}</button>` : ''}
        </div>`;
    }

    function gridItemHtml(image, isOwner = false) {
        const encoded = encodeURIComponent(image.blobName);
        return `
        <div class="grid-item" onclick="pixora.openImage(${image.id || 0})">
            <img src="/image/${encoded}" alt="${escapeHtml(image.fileName)}" loading="lazy">
            <div class="grid-overlay">
                <span>${image.likeCount} ${heartIcon(false)}</span>
                <span>${image.commentCount} ${commentIcon()}</span>
                ${isOwner ? `<button class="grid-delete" onclick="event.stopPropagation(); pixora.deletePost('${encoded}');" aria-label="Delete post" title="Delete">${trashIcon()}</button>` : ''}
            </div>
        </div>`;
    }

    function emptyStateHtml(title, message, action) {
        return `
        <div class="empty-state">
            <div class="empty-state-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4" ry="4"></rect><circle cx="12" cy="12" r="3"></circle><line x1="16.5" y1="7.5" x2="16.5" y2="7.5"></line></svg>
            </div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(message)}</p>
            ${action ? `<button class="btn btn-primary" onclick="pixora.navigate('${action}')">${action === 'upload' ? 'Upload a photo' : 'Go to ' + action}</button>` : ''}
        </div>`;
    }

    function loadingHtml() {
        return `<div class="loading-screen"><div class="loading-logo">Pixora</div><p>Capture. Share. Connect.</p><div class="loading-spinner"></div></div>`;
    }

    // ---------- Auth View ----------
    function renderAuth(mode) {
        if (!mode) {
            const params = new URLSearchParams(window.location.search);
            mode = params.get('mode') === 'signup' ? 'signup' : 'signin';
        }
        const content = $('#content');
        content.className = 'content';
        content.innerHTML = `
        <div class="auth-view">
            <div class="auth-box">
                <a href="/" class="logo" data-nav="home">
                    <svg class="logo-mark" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <rect x="3" y="3" width="34" height="34" rx="8" stroke="currentColor" stroke-width="3"/>
                        <path d="M12 30V10h9c5 0 8 3 8 7.5 0 4.5-3 7.5-8 7.5h-4" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                        <circle cx="15" cy="28" r="3" fill="currentColor"/>
                    </svg>
                    <span>Pixora</span>
                </a>
                <p class="tagline">Capture. Share. Connect.</p>
                <form class="auth-form" id="authForm">
                    ${mode === 'signup' ? `
                    <div class="form-group">
                        <label for="authUsername">Username</label>
                        <input type="text" id="authUsername" class="form-input" placeholder="photographer_42" maxlength="30" required>
                    </div>
                    <div class="form-group">
                        <label for="authEmail">Email</label>
                        <input type="email" id="authEmail" class="form-input" placeholder="you@example.com" required>
                    </div>
                    <div class="form-group">
                        <label for="authBio">Bio (optional)</label>
                        <textarea id="authBio" class="form-input" placeholder="A few words about you" maxlength="500"></textarea>
                    </div>
                    ` : `
                    <div class="form-group">
                        <label for="authIdentifier">Username or email</label>
                        <input type="text" id="authIdentifier" class="form-input" placeholder="you@example.com" required>
                    </div>
                    `}
                    <div class="form-group">
                        <label for="authPassword">Password</label>
                        <input type="password" id="authPassword" class="form-input" placeholder="••••••••" minlength="6" required>
                    </div>
                    <div class="form-error" id="authError"></div>
                    <button type="submit" class="btn btn-primary" id="authSubmit">${mode === 'signup' ? 'Create account' : 'Sign in'}</button>
                </form>
                <div class="auth-toggle">
                    ${mode === 'signup' ? 'Already have an account?' : "Don't have an account?"}
                    <button id="authToggle">${mode === 'signup' ? 'Sign in' : 'Create account'}</button>
                </div>
            </div>
        </div>`;

        bindAuthForm(mode);
    }

    function bindAuthForm(mode) {
        $('#authForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const errorEl = $('#authError');
            errorEl.classList.remove('visible');

            const password = $('#authPassword').value;
            let result;

            try {
                if (mode === 'signup') {
                    const username = $('#authUsername').value.trim();
                    const email = $('#authEmail').value.trim();
                    const bio = $('#authBio').value.trim();
                    result = await signUp(username, email, password, bio);
                } else {
                    const identifier = $('#authIdentifier').value.trim();
                    result = await signIn(identifier, password);
                }

                await setUser(result.user);
                showToast(mode === 'signup' ? 'Welcome to Pixora!' : 'Signed in successfully', 'success');
                navigateTo('home');
            } catch (err) {
                errorEl.textContent = err.message;
                errorEl.classList.add('visible');
            }
        });

        $('#authToggle').addEventListener('click', () => {
            renderAuth(mode === 'signup' ? 'signin' : 'signup');
        });
    }

    // ---------- Views ----------
    async function renderHome() {
        const content = $('#content');
        content.className = 'content';
        content.innerHTML = loadingHtml();

        try {
            await loadImages();
            const images = state.images;
            content.innerHTML = images.length
                ? `<div class="feed">${images.map(postCardHtml).join('')}</div>`
                : emptyStateHtml('No posts yet', 'Be the first to share a moment on Pixora.', 'upload');
            bindPostEvents();
            updatePanelStats();
        } catch (err) {
            content.innerHTML = emptyStateHtml('Could not load feed', err.message, 'upload');
        }
    }

    async function renderExplore() {
        const content = $('#content');
        content.className = 'content';
        content.innerHTML = loadingHtml();

        try {
            await loadExplore();
            const data = state.explore;
            const tags = (data.popularTags || []).slice(0, 6);
            const trending = data.trending || [];
            const recent = data.recent || [];
            const totalImages = data.totalImages || 0;

            const heroFeatured = trending.slice(0, 3);
            const tagList = tags.length ? tags.map(t => `<button class="tag-pill-light" onclick="pixora.searchTag('${escapeHtml(t.tag)}')">#${escapeHtml(t.tag)}</button>`).join('') : '';

            content.innerHTML = `
            <div class="explore-hero">
                <div class="explore-hero-content">
                    <h1>Explore</h1>
                    <p>Discover moments and creators from the Pixora community</p>
                    ${tagList ? `<div class="explore-tags">${tagList}</div>` : ''}
                    <div class="explore-stats">${totalImages.toLocaleString()} moments shared</div>
                </div>
                ${heroFeatured.length ? `<div class="explore-hero-grid">${heroFeatured.map((img, i) => exploreHeroHtml(img, i)).join('')}</div>` : ''}
            </div>
            <div class="explore-tabs">
                <button class="explore-tab active" id="tab-trending" onclick="pixora.switchExploreTab('trending')">Trending</button>
                <button class="explore-tab" id="tab-recent" onclick="pixora.switchExploreTab('recent')">Recent</button>
            </div>
            <div class="masonry-grid" id="exploreGrid">
                ${trending.length ? trending.map(gridItemHtml).join('') : emptyStateHtml('No posts yet', 'Upload to start exploring.', 'upload')}
            </div>`;
        } catch (err) {
            content.innerHTML = emptyStateHtml('Could not load explore', err.message, 'upload');
        }
    }

    function exploreHeroHtml(image, index) {
        const encoded = encodeURIComponent(image.blobName);
        return `
        <div class="explore-hero-item item-${index}" onclick="pixora.openImage(${image.id || 0})">
            <img src="/image/${encoded}" alt="${escapeHtml(image.fileName)}" loading="lazy">
        </div>`;
    }

    function renderUpload() {
        const content = $('#content');
        content.className = 'content';
        content.innerHTML = `
        <div class="page-header">
            <h1>Upload</h1>
            <p>Share your moment with the Pixora community</p>
        </div>
        <div class="upload-card">
            <div class="upload-area" id="uploadArea">
                <div class="upload-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                </div>
                <p class="upload-text">Drag photos here or click to browse</p>
                <p class="upload-hint">JPG, PNG, GIF up to 10MB</p>
                <input type="file" id="uploadInput" accept="image/*" multiple hidden>
            </div>
            <div class="form-group" style="margin-top:16px">
                <label for="uploadCaption">Caption</label>
                <textarea id="uploadCaption" class="form-input" placeholder="What's the story behind this photo?" maxlength="1000"></textarea>
            </div>
            <div class="upload-progress" id="uploadProgress" style="display:none">
                <div class="upload-progress-bar" id="uploadProgressBar"></div>
            </div>
            <div class="upload-progress-text" id="uploadProgressText"></div>
            <div class="upload-preview" id="uploadPreview"></div>
            <button class="btn btn-primary" id="uploadSubmit" style="margin-top:16px;width:100%" disabled>Share to Pixora</button>
        </div>`;

        bindUploadEvents();
    }

    async function renderAnalytics() {
        const content = $('#content');
        content.className = 'content';
        content.innerHTML = loadingHtml();

        try {
            await loadAnalytics();
            const a = state.analytics;
            content.innerHTML = `
            <div class="page-header">
                <h1>Analytics</h1>
                <p>Platform insights and activity</p>
            </div>
            <div class="analytics-grid">
                <div class="analytics-card">
                    <div class="label">Total Posts</div>
                    <div class="value">${a.totalImages}</div>
                </div>
                <div class="analytics-card">
                    <div class="label">Total Users</div>
                    <div class="value">${a.totalUsers}</div>
                </div>
                <div class="analytics-card">
                    <div class="label">Total Likes</div>
                    <div class="value">${a.totalLikes}</div>
                </div>
                <div class="analytics-card">
                    <div class="label">Total Comments</div>
                    <div class="value">${a.totalComments}</div>
                </div>
                <div class="analytics-card">
                    <div class="label">Storage Used</div>
                    <div class="value">${a.totalSizeFormatted}</div>
                </div>
                <div class="analytics-card">
                    <div class="label">Most Active</div>
                    <div class="value" style="font-size:18px">${a.topUploader ? escapeHtml(a.topUploader.name) : '—'}</div>
                    <div class="meta">${a.topUploader ? a.topUploader.count + ' posts' : ''}</div>
                </div>
                <div class="analytics-card wide">
                    <div class="label">Upload Trends (14 days)</div>
                    <div class="chart-bars">
                        ${a.trends.length ? a.trends.map(t => `<div class="chart-bar"><div class="chart-bar-fill" style="height:${Math.max(10, t.count * 20)}px"></div><div class="chart-bar-label">${new Date(t.date).getDate()}</div></div>`).join('') : '<span style="color:var(--text-tertiary)">No data</span>'}
                    </div>
                </div>
                <div class="analytics-card wide">
                    <div class="label">Most Used Tags</div>
                    <div class="analytics-tags">
                        ${a.mostUsedTags.length ? a.mostUsedTags.map(t => `<span class="analytics-tag">#${escapeHtml(t.tag)} <span>${t.count}</span></span>`).join('') : '<span style="color:var(--text-tertiary)">No tags yet</span>'}
                    </div>
                </div>
                <div class="analytics-card wide">
                    <div class="label">Recent Activity</div>
                    <div class="activity-list">
                        ${a.activeUsers.length ? a.activeUsers.map(u => `<div class="activity-row"><span>${escapeHtml(u.uploader)}</span><span>${u.count} posts this month</span></div>`).join('') : '<span style="color:var(--text-tertiary)">No recent activity</span>'}
                    </div>
                </div>
            </div>`;
        } catch (err) {
            content.innerHTML = emptyStateHtml('Analytics unavailable', err.message, 'home');
        }
    }

    async function renderProfile(params) {
        const content = $('#content');
        content.className = 'content';
        content.innerHTML = loadingHtml();

        try {
            const target = params?.user || state.user?.username || 'anonymous';
            const p = await loadProfile(target);
            const isOwner = state.user && p.uploader === state.user.username;

            content.innerHTML = `
            <div class="profile-header">
                <div class="avatar-section">
                    ${isOwner
                        ? `<label class="avatar-upload" title="Change profile picture">
                            ${avatarHtml(p.uploader, p.avatar, 'avatar-xl')}
                            <input type="file" id="avatarInput" accept="image/*" hidden>
                            <div class="avatar-upload-overlay">Change</div>
                          </label>`
                        : avatarHtml(p.uploader, p.avatar, 'avatar-xl')}
                </div>
                <div class="profile-info">
                    <h1 class="profile-name">${escapeHtml(p.uploader)}</h1>
                    <p class="profile-bio">${escapeHtml(p.bio || 'No bio yet')}</p>
                    <div class="profile-stats">
                        <div class="profile-stat"><strong>${p.posts}</strong> posts</div>
                        <div class="profile-stat"><strong>${p.likesReceived}</strong> likes</div>
                        <div class="profile-stat"><strong>${p.joined}</strong> joined</div>
                    </div>
                    ${isOwner ? `<button class="btn btn-secondary btn-sm" onclick="pixora.navigate('settings')">Edit profile</button>` : ''}
                </div>
            </div>
            <div class="profile-grid">
                ${p.images.length ? p.images.map(img => gridItemHtml(img, isOwner)).join('') : emptyStateHtml('No posts yet', 'Share your first photo to see it here.', 'upload')}
            </div>`;

            if (isOwner) bindAvatarUpload();
        } catch (err) {
            content.innerHTML = emptyStateHtml('Profile unavailable', err.message, 'home');
        }
    }

    function renderSettings() {
        const content = $('#content');
        content.className = 'content';
        if (!state.user) {
            content.innerHTML = emptyStateHtml('Sign in required', 'Please sign in to edit your profile.', 'home');
            return;
        }

        content.innerHTML = `
        <div class="page-header">
            <h1>Settings</h1>
            <p>Manage your Pixora profile</p>
        </div>
        <div class="settings-card">
            <div class="settings-item">
                <div class="settings-info">
                    <h3>Profile Picture</h3>
                    <p>Update your public avatar</p>
                </div>
                <label class="avatar-upload" style="width:64px;height:64px">
                    ${avatarHtml(state.user.username, state.avatar, '')}
                    <input type="file" id="avatarInput" accept="image/*" hidden>
                    <div class="avatar-upload-overlay">Change</div>
                </label>
            </div>
            <div class="settings-item">
                <div class="settings-info">
                    <h3>Username</h3>
                    <p>@${state.user.username}</p>
                </div>
            </div>
            <div class="settings-item">
                <div class="settings-info">
                    <h3>Email</h3>
                    <p>${escapeHtml(state.user.email)}</p>
                </div>
            </div>
            <div class="settings-item">
                <div class="settings-info" style="flex:1">
                    <h3>Bio</h3>
                    <textarea id="settingsBio" class="form-input" maxlength="500" style="margin-top:8px">${escapeHtml(state.bio || '')}</textarea>
                </div>
            </div>
            <div class="settings-item">
                <div class="settings-info">
                    <h3>Theme</h3>
                    <p>Switch between light and dark mode</p>
                </div>
                <button class="btn btn-secondary" id="settingsThemeToggle">Switch to ${state.theme === 'light' ? 'dark' : 'light'} mode</button>
            </div>
            <div class="settings-item" style="border-bottom:none">
                <button class="btn btn-primary" id="saveBioBtn">Save bio</button>
            </div>
        </div>

        <div class="settings-card" style="margin-top:24px">
            <div class="settings-item">
                <div class="settings-info" style="flex:1">
                    <h3>Change Password</h3>
                    <p>Update your account password</p>
                    <div class="form-group" style="margin-top:12px">
                        <label for="currentPassword">Current password</label>
                        <input type="password" id="currentPassword" class="form-input" placeholder="••••••••">
                    </div>
                    <div class="form-group" style="margin-top:12px">
                        <label for="newPassword">New password</label>
                        <input type="password" id="newPassword" class="form-input" placeholder="••••••••">
                    </div>
                    <div class="form-error" id="passwordError"></div>
                </div>
            </div>
            <div class="settings-item" style="border-bottom:none">
                <button class="btn btn-primary" id="changePasswordBtn">Change password</button>
            </div>
        </div>

        <div class="settings-card" style="margin-top:24px">
            <div class="settings-item">
                <div class="settings-info">
                    <h3>Danger Zone</h3>
                    <p>Permanently delete your account and all your posts</p>
                </div>
            </div>
            <div class="settings-item" style="border-bottom:none">
                <button class="btn btn-danger" id="deleteAccountBtn">Delete account</button>
            </div>
            <div class="settings-item" style="border-bottom:none">
                <button class="btn btn-secondary" id="settingsSignOut">Sign Out</button>
            </div>
        </div>`;

        bindAvatarUpload();
        $('#saveBioBtn').addEventListener('click', async () => {
            const bio = $('#settingsBio').value.trim();
            try {
                await updateProfile(bio);
                state.bio = bio;
                showToast('Profile updated', 'success');
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
        $('#settingsThemeToggle').addEventListener('click', () => {
            toggleTheme();
            renderSettings();
        });
        $('#settingsSignOut').addEventListener('click', async () => {
            try {
                await signOut();
                clearUser();
                showToast('Signed out', 'success');
                navigateTo('home');
            } catch (err) {
                showToast(err.message, 'error');
            }
        });

        $('#changePasswordBtn').addEventListener('click', async () => {
            const errorEl = $('#passwordError');
            errorEl.classList.remove('visible');
            const currentPassword = $('#currentPassword').value;
            const newPassword = $('#newPassword').value;
            if (!currentPassword || !newPassword) {
                errorEl.textContent = 'Both fields are required';
                errorEl.classList.add('visible');
                return;
            }
            if (newPassword.length < 6) {
                errorEl.textContent = 'New password must be at least 6 characters';
                errorEl.classList.add('visible');
                return;
            }
            try {
                await changePassword(currentPassword, newPassword);
                $('#currentPassword').value = '';
                $('#newPassword').value = '';
                showToast('Password updated', 'success');
            } catch (err) {
                errorEl.textContent = err.message;
                errorEl.classList.add('visible');
            }
        });

        $('#deleteAccountBtn').addEventListener('click', async () => {
            if (!confirm('Delete your account permanently? All your posts, comments, and likes will be removed. This cannot be undone.')) return;
            try {
                await deleteAccount();
                clearUser();
                showToast('Account deleted', 'success');
                navigateTo('home');
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    function renderSearch(q) {
        const content = $('#content');
        content.className = 'content';
        content.innerHTML = loadingHtml();

        searchImages(q).then(() => {
            content.innerHTML = `
            <div class="page-header" style="margin-bottom:16px">
                <h1>Search results</h1>
                <p>${state.images.length} result${state.images.length === 1 ? '' : 's'} for "${escapeHtml(q)}"</p>
            </div>
            ${state.images.length ? `<div class="feed">${state.images.map(postCardHtml).join('')}</div>` : emptyStateHtml('No results', `No posts found for "${escapeHtml(q)}"`, 'upload')}`;
            bindPostEvents();
        }).catch(err => {
            content.innerHTML = emptyStateHtml('Search failed', err.message, 'home');
        });
    }

    // ---------- Routing ----------
    function parseRoute() {
        const path = window.location.pathname.replace(/^\//, '') || 'home';
        const parts = path.split('/');
        const view = parts[0];
        const params = { user: parts[1] };
        return { view, params };
    }

    function navigateTo(view, params) {
        if (!state.user && protectedRoutes.includes(view)) {
            view = 'auth';
            params = {};
        }

        if (!routes.includes(view) && view !== 'auth') {
            view = 'home';
        }

        state.view = view;

        // Update nav active states
        $$('[data-nav]').forEach(el => {
            el.classList.toggle('active', el.dataset.nav === view);
        });

        // Update URL
        if (view === 'auth') {
            const m = params?.mode || 'signin';
            history.pushState(null, '', '/auth?mode=' + m);
        } else if (view === 'profile' && params?.user) {
            history.pushState(null, '', '/profile/' + params.user);
        } else {
            history.pushState(null, '', '/' + view);
        }

        const content = $('#content');
        content.scrollTop = 0;
        window.scrollTo(0, 0);

        switch (view) {
            case 'home': renderHome(); break;
            case 'explore': renderExplore(); break;
            case 'upload': renderUpload(); break;
            case 'analytics': renderAnalytics(); break;
            case 'profile': renderProfile(params); break;
            case 'settings': renderSettings(); break;
            case 'auth': renderAuth(params?.mode); break;
            default: renderHome();
        }
    }

    // ---------- Bindings ----------
    function bindPostEvents() {
        $$('.post-card').forEach(card => {
            const id = parseInt(card.dataset.id, 10);
            if (!id) return;

            const input = card.querySelector(`#comment-input-${id}`);
            if (input) {
                input.addEventListener('keypress', e => {
                    if (e.key === 'Enter') window.pixora.postComment(id);
                });
            }
        });
    }

    function bindUploadEvents() {
        const area = $('#uploadArea');
        const input = $('#uploadInput');
        const preview = $('#uploadPreview');
        const submit = $('#uploadSubmit');
        const caption = $('#uploadCaption');
        let files = [];

        area.addEventListener('click', () => input.click());
        area.addEventListener('dragover', e => { e.preventDefault(); area.classList.add('dragover'); });
        area.addEventListener('dragleave', () => area.classList.remove('dragover'));
        area.addEventListener('drop', e => {
            e.preventDefault();
            area.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        });
        input.addEventListener('change', () => handleFiles(input.files));

        function handleFiles(fileList) {
            files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
            if (!files.length) return;
            preview.innerHTML = files.map(f => `<div class="preview-item"><img src="${URL.createObjectURL(f)}" alt="${escapeHtml(f.name)}"></div>`).join('');
            submit.disabled = false;
        }

        submit.addEventListener('click', () => {
            if (!files.length) return;

            const formData = new FormData();
            files.forEach(f => formData.append('images', f));
            formData.append('caption', caption.value.trim());

            const xhr = new XMLHttpRequest();
            const progressBar = $('#uploadProgressBar');
            const progressWrap = $('#uploadProgress');
            const progressText = $('#uploadProgressText');

            progressWrap.style.display = 'block';
            progressText.textContent = 'Uploading...';
            submit.disabled = true;

            xhr.upload.addEventListener('progress', e => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    progressBar.style.width = pct + '%';
                    progressText.textContent = `Uploading ${pct}%`;
                }
            });

            xhr.addEventListener('load', () => {
                progressBar.style.width = '100%';
                progressText.textContent = 'Processing...';

                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data.success) {
                        showToast('Upload complete!', 'success');
                        files = [];
                        preview.innerHTML = '';
                        caption.value = '';
                        progressWrap.style.display = 'none';
                        progressBar.style.width = '0%';
                        submit.disabled = true;
                        navigateTo('home');
                    } else {
                        throw new Error(data.message || 'Upload failed');
                    }
                } catch (err) {
                    progressText.textContent = err.message;
                    showToast(err.message, 'error');
                    submit.disabled = false;
                }
            });

            xhr.addEventListener('error', () => {
                progressText.textContent = 'Upload failed';
                showToast('Upload failed', 'error');
                submit.disabled = false;
            });

            xhr.open('POST', '/upload');
            xhr.send(formData);
        });
    }

    function bindAvatarUpload() {
        const input = $('#avatarInput');
        if (!input) return;
        input.addEventListener('change', async () => {
            if (!input.files || !input.files[0]) return;
            const formData = new FormData();
            formData.append('avatar', input.files[0]);

            try {
                const data = await api('/api/avatar', {
                    method: 'POST',
                    body: formData
                });
                state.avatar = data.avatar;
                updateUserDisplays();
                showToast('Profile picture updated', 'success');
                if (state.view === 'profile') renderProfile({ user: state.user.username });
                if (state.view === 'settings') renderSettings();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    function bindNavigation() {
        $$('[data-nav]').forEach(el => {
            el.addEventListener('click', e => {
                e.preventDefault();
                navigateTo(el.dataset.nav);
            });
        });

        window.addEventListener('popstate', () => {
            const { view, params } = parseRoute();
            navigateTo(view, params);
        });

        $('#searchInput').addEventListener('input', debounce(handleSearch, 300));
        $('#searchInput').addEventListener('keypress', e => {
            if (e.key === 'Enter') handleSearch();
        });

        $('#themeToggle').addEventListener('click', toggleTheme);
        $('#signOutBtn').addEventListener('click', async () => {
            try {
                await signOut();
                clearUser();
                showToast('Signed out', 'success');
                navigateTo('home');
            } catch (err) {
                showToast(err.message, 'error');
            }
        });

        $('#signInBtn')?.addEventListener('click', () => navigateTo('auth'));
        $('#signUpBtn')?.addEventListener('click', () => navigateTo('auth', { mode: 'signup' }));
        $('#headerSignIn')?.addEventListener('click', () => navigateTo('auth'));

        // Delegate profile links inside posts
        document.addEventListener('click', (e) => {
            const userLink = e.target.closest('[data-user]');
            if (userLink) {
                e.preventDefault();
                navigateTo('profile', { user: userLink.dataset.user });
            }
        });

        window.addEventListener('scroll', () => {
            const header = $('#mainHeader');
            header.classList.toggle('scrolled', window.scrollY > 8);
        });
    }

    function handleSearch() {
        const q = $('#searchInput').value.trim();
        if (!q) {
            navigateTo('home');
            return;
        }
        navigateTo('home');
        renderSearch(q);
    }

    // ---------- User Display ----------
    async function setUser(user) {
        state.user = user;
        state.bio = user.bio || '';
        state.avatar = user.avatar || null;
        updateUserDisplays();
    }

    function clearUser() {
        state.user = null;
        state.bio = '';
        state.avatar = null;
        updateUserDisplays();
    }

    function updateUserDisplays() {
        const isAuth = !!state.user;
        const username = state.user?.username || 'Pixora';

        $('#panelUsername').textContent = username;
        $('#panelHandle').textContent = isAuth ? '@' + username : 'Sign in to share';
        $('#panelAvatar').innerHTML = avatarHtml(username, state.avatar, 'avatar-lg');

        $('#authCard').style.display = isAuth ? 'none' : 'flex';
        $('#signOutBtn').classList.toggle('hidden', !isAuth);
        $('#headerAvatar').innerHTML = avatarHtml(username, state.avatar, '');
        $('#headerSignIn').classList.toggle('hidden', isAuth);
        $('#headerProfileLink').style.display = isAuth ? 'flex' : 'none';

        // Hide upload from bottom nav if not authenticated
        $$('.bottom-nav .upload-btn').forEach(el => {
            el.style.display = isAuth ? 'flex' : 'none';
        });
    }

    async function updatePanelStats() {
        try {
            const a = await loadAnalytics();
            $('#panelPosts').textContent = a.totalImages;
            $('#panelLikes').textContent = a.totalLikes;
            $('#panelUsers').textContent = a.totalUsers;
        } catch (err) {
            // silent
        }
    }

    function debounce(fn, wait) {
        let t;
        return function (...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    // ---------- Global Actions ----------
    window.pixora = {
        navigate: navigateTo,
        toggleLike,
        toggleSave: (id) => {
            const idx = state.saved.indexOf(id);
            if (idx === -1) state.saved.push(id);
            else state.saved.splice(idx, 1);
            localStorage.setItem('pixora_saved', JSON.stringify(state.saved));
            const btn = $(`#save-btn-${id}`);
            if (btn) {
                btn.classList.toggle('saved', idx === -1);
                btn.innerHTML = bookmarkIcon(idx === -1);
            }
            showToast(idx === -1 ? 'Saved to collection' : 'Removed from collection', 'success');
        },
        postComment: async (id) => {
            const input = $(`#comment-input-${id}`);
            const text = input.value.trim();
            if (!text) return;
            try {
                await submitComment(id, text);
                input.value = '';
                await loadComments(id);
            } catch (err) {
                showToast(err.message, 'error');
            }
        },
        openComments: async (id) => {
            const section = $(`#comments-section-${id}`);
            const isOpen = section.classList.toggle('open');
            if (isOpen) await loadComments(id);
        },
        sharePost: (encodedName, name) => {
            const url = window.location.origin + '/image/' + encodedName;
            if (navigator.share) {
                navigator.share({ title: 'Pixora - ' + name, url });
            } else if (navigator.clipboard) {
                navigator.clipboard.writeText(url).then(() => showToast('Link copied to clipboard', 'success'));
            } else {
                showToast(url, 'info');
            }
        },
        searchTag: (tag) => {
            $('#searchInput').value = tag;
            handleSearch();
        },
        switchExploreTab: (tab) => {
            $('#tab-trending').classList.toggle('active', tab === 'trending');
            $('#tab-recent').classList.toggle('active', tab === 'recent');
            const grid = $('#exploreGrid');
            const list = tab === 'trending' ? state.explore.trending : state.explore.recent;
            grid.innerHTML = list.length ? list.map(gridItemHtml).join('') : emptyStateHtml('No posts', 'Nothing here yet.', 'upload');
        },
        openImage: (id) => {
            const image = state.images.find(i => i.id === id) || (state.explore && state.explore.trending.find(i => i.id === id)) || (state.profile && state.profile.images.find(i => i.id === id));
            if (!image) return;
            navigateTo('home');
            setTimeout(() => {
                const card = $(`.post-card[data-id="${id}"]`);
                if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 300);
        },
        deletePost: (blobName) => {
            if (confirm('Delete this post? This cannot be undone.')) {
                deleteImage(blobName).catch(err => showToast(err.message, 'error'));
            }
        },
        clearSaved: () => {
            state.saved = [];
            localStorage.setItem('pixora_saved', '[]');
            showToast('Saved collection cleared', 'success');
        }
    };

    // ---------- Initialization ----------
    async function init() {
        applyTheme();
        bindNavigation();

        try {
            const data = await getMe();
            if (data.user) {
                await setUser(data.user);
            } else {
                clearUser();
            }
        } catch (err) {
            clearUser();
        }

        const { view, params } = parseRoute();
        navigateTo(view, params);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
