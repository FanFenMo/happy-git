<template>
  <section class="portrait-canvas-shell rounded-2xl border border-[var(--color-border)] overflow-hidden" aria-label="动态个人技术画像">
    <!-- 顶部控制栏 -->
    <header class="portrait-toolbar flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] no-select">
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border"
          :class="model.sourceKind === 'cloud'
            ? 'bg-emerald-500/10 text-[var(--color-success)] border-emerald-500/25'
            : 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)] border-[var(--color-border)]'"
        >
          <span
            class="w-2 h-2 rounded-full"
            :class="model.sourceKind === 'cloud' ? 'bg-[var(--color-success)] animate-pulse' : 'bg-[var(--color-primary)]'"
          ></span>
          {{ model.sourceKind === 'cloud' ? '云端模型画像' : model.sourceKind === 'local' ? '本机实时画像' : '等待同步画像' }}
        </span>
        <span class="text-[11px] font-mono text-[var(--color-text-subtle)]">
          {{ model.modelVersion }}
        </span>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <!-- 视图模式切换 -->
        <div role="tablist" aria-label="画像展示模式" class="inline-flex items-center p-0.5 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)]">
          <button
            v-for="mode in viewModes"
            :key="mode.id"
            role="tab"
            type="button"
            :aria-selected="activeMode === mode.id"
            @click="switchMode(mode.id)"
            class="px-2.5 py-1 rounded-lg text-[11px] font-semibold transition cursor-pointer"
            :class="activeMode === mode.id
              ? 'bg-[var(--color-surface)] text-[var(--color-primary)] shadow-sm'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'"
          >
            {{ mode.label }}
          </button>
        </div>

        <button
          type="button"
          @click="replayAnimation"
          class="px-2.5 py-1 rounded-xl bg-[var(--color-surface-raised)] border border-[var(--color-border)] hover:border-[var(--color-primary)] text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition cursor-pointer"
          title="重播生长特效"
        >
          重播特效
        </button>

        <button
          v-if="!userStore.cloudSync.cloudBound && userStore.cloudAuthStage !== 'authorizing'"
          type="button"
          @click="authorizeAndSync"
          class="px-3 py-1 rounded-xl btn-primary text-[11px] !min-h-0 cursor-pointer"
        >
          授权并更新云端画像
        </button>
        <button
          v-else-if="userStore.cloudAuthStage === 'authorizing'"
          type="button"
          @click="userStore.cancelCloudBind()"
          class="px-3 py-1 rounded-xl btn-secondary text-[11px] !min-h-0 cursor-pointer"
        >
          授权中（点击取消）
        </button>
        <button
          v-else
          type="button"
          @click="refreshCloudNow"
          :disabled="userStore.cloudPortraitLoading"
          class="px-3 py-1 rounded-xl btn-secondary text-[11px] !min-h-0 cursor-pointer"
        >
          {{ userStore.cloudPortraitLoading ? '正在计算...' : '更新云端画像' }}
        </button>
      </div>
    </header>

    <!-- 授权 / 自动更新实时提示 -->
    <div
      v-if="updateBanner || userStore.cloudAuthError"
      class="px-4 py-2 text-xs flex items-center justify-between border-b border-[var(--color-border)]"
      :class="userStore.cloudAuthError ? 'bg-red-50 text-[var(--color-danger)]' : 'bg-emerald-50 text-[var(--color-success)]'"
    >
      <span>{{ userStore.cloudAuthError || updateBanner }}</span>
      <button
        type="button"
        @click="dismissBanner"
        class="text-[11px] underline cursor-pointer ml-3 shrink-0"
      >
        知道了
      </button>
    </div>

    <!-- 空状态引导 -->
    <div v-if="model.branches.length === 0" class="portrait-stage px-6 py-14 text-center space-y-3">
      <div class="w-12 h-12 mx-auto rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] grid place-items-center text-xl">
        🌱
      </div>
      <div class="text-sm font-bold text-[var(--color-text)]">画像树正在等待您的项目与兴趣线索</div>
      <p class="text-xs text-[var(--color-text-muted)] max-w-md mx-auto leading-relaxed">
        同步公开仓库、Star 或浏览几个开源项目后，这里会自动生长出您的个人技术树状图与能力雷达。
      </p>
      <div class="flex flex-wrap items-center justify-center gap-2 pt-1">
        <button
          type="button"
          @click="userStore.refreshAccountData(true)"
          class="px-4 py-2 rounded-xl btn-secondary text-xs !min-h-0 cursor-pointer"
        >
          同步公开项目与 Star
        </button>
        <button
          v-if="!userStore.cloudSync.cloudBound"
          type="button"
          @click="authorizeAndSync"
          class="px-4 py-2 rounded-xl btn-primary text-xs !min-h-0 cursor-pointer"
        >
          授权并更新云端画像
        </button>
      </div>
    </div>

    <!-- 主动态画布 -->
    <div v-else class="portrait-stage relative">
      <!-- 刚更新完云端画像的扩散波纹 -->
      <div v-if="pulseKey > 0" :key="`wave-${pulseKey}`" class="portrait-update-wave" aria-hidden="true"></div>

      <!-- 模式 1：动态技术树状图 -->
      <div v-if="activeMode === 'tree'" class="portrait-svg-wrap" :key="`tree-${animEpoch}`">
        <svg
          :viewBox="`0 0 ${treeLayout.width} ${treeLayout.height}`"
          class="portrait-tree-svg w-full h-auto block"
          role="img"
          :aria-label="`${model.root.label} 的动态个人技术画像树状图`"
        >
          <defs>
            <radialGradient id="hgRootGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="#315ee7" stop-opacity="0.28" />
              <stop offset="100%" stop-color="#315ee7" stop-opacity="0" />
            </radialGradient>
            <filter id="hgSoftGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <!-- 连线层：先绘制树枝，再叠加沿路径流动的光点 -->
          <g class="tree-edges">
            <g
              v-for="edge in treeLayout.edges"
              :key="edge.id"
              :class="{
                'is-dimmed': hoveredBranchId && hoveredBranchId !== edge.branchId,
                'is-highlighted': hoveredBranchId === edge.branchId
              }"
            >
              <path
                :id="`path-${edge.id}`"
                :d="edge.d"
                fill="none"
                :stroke="edge.color"
                :stroke-width="edge.level === 1 ? 2.6 : 1.75"
                :stroke-opacity="hoveredBranchId === edge.branchId ? 0.9 : 0.42"
                stroke-linecap="round"
                class="tree-branch-path"
                :style="{ '--path-len': edge.length, '--grow-delay': `${edge.delay}ms` }"
              />
              <circle
                v-if="!reducedMotion"
                :r="edge.level === 1 ? 3.2 : 2.3"
                :fill="edge.color"
                filter="url(#hgSoftGlow)"
                class="tree-flow-particle"
              >
                <animateMotion
                  :dur="`${edge.flowDur}s`"
                  :begin="`${edge.delay / 1000}s`"
                  repeatCount="indefinite"
                  :path="edge.d"
                />
              </circle>
            </g>
          </g>

          <!-- 根节点 -->
          <g
            class="tree-root-node cursor-pointer"
            :transform="`translate(${treeLayout.root.x}, ${treeLayout.root.y})`"
            @click="selectNode({ type: 'root', label: model.root.label, subtitle: model.root.primaryFocus, sharePercent: 100, color: '#315ee7', evidenceRepos: [] })"
          >
            <circle r="44" fill="url(#hgRootGlow)" class="root-halo" />
            <circle r="29" fill="#ffffff" stroke="#315ee7" stroke-width="2.4" />
            <circle r="24" fill="#edf2ff" />
            <text text-anchor="middle" dy="-2" font-size="11.5" font-weight="700" fill="#18283e">
              {{ truncateLabel(model.root.label, 8) }}
            </text>
            <text text-anchor="middle" dy="12" font-size="9.5" font-family="monospace" fill="#315ee7">
              {{ model.sourceKind === 'cloud' ? 'CLOUD' : 'LOCAL' }}
            </text>
          </g>

          <!-- L1 分类分支节点（点击可折叠/展开子树） -->
          <g
            v-for="branch in treeLayout.branchNodes"
            :key="branch.id"
            class="tree-branch-node cursor-pointer"
            :class="{ 'is-dimmed': hoveredBranchId && hoveredBranchId !== branch.branchId }"
            :transform="`translate(${branch.x}, ${branch.y})`"
            :style="{ '--node-delay': `${branch.delay}ms` }"
            @mouseenter="hoveredBranchId = branch.branchId"
            @mouseleave="hoveredBranchId = null"
            @click="toggleBranch(branch)"
          >
            <rect
              x="-66"
              y="-18"
              width="132"
              height="36"
              rx="18"
              fill="#ffffff"
              :stroke="branch.color"
              :stroke-width="selectedNode?.id === branch.id ? 2.4 : 1.6"
            />
            <circle cx="-48" cy="0" r="5" :fill="branch.color" />
            <text x="-38" y="4" font-size="11.5" font-weight="700" fill="#18283e">
              {{ branch.label }}
            </text>
            <text x="52" y="4" text-anchor="end" font-size="10" font-family="monospace" :fill="branch.color">
              {{ collapsedBranches.has(branch.branchId) ? `+${branch.childCount}` : '−' }}
            </text>
          </g>

          <!-- L2 叶子权重节点 -->
          <g
            v-for="leaf in treeLayout.leafNodes"
            :key="leaf.id"
            class="tree-leaf-node cursor-pointer"
            :class="{
              'is-dimmed': hoveredBranchId && hoveredBranchId !== leaf.branchId,
              'is-selected': selectedNode?.id === leaf.id
            }"
            :transform="`translate(${leaf.x}, ${leaf.y})`"
            :style="{ '--node-delay': `${leaf.delay}ms` }"
            @mouseenter="hoveredBranchId = leaf.branchId"
            @mouseleave="hoveredBranchId = null"
            @click="selectNode(leaf)"
          >
            <circle
              cx="0"
              cy="0"
              :r="leaf.radius"
              fill="#ffffff"
              :stroke="leaf.color"
              :stroke-width="selectedNode?.id === leaf.id ? 2.5 : 1.8"
            />
            <circle
              cx="0"
              cy="0"
              :r="Math.max(3, leaf.radius - 3)"
              :fill="leaf.color"
              fill-opacity="0.18"
              :class="{ 'leaf-pulse': leaf.isTop }"
            />
            <text x="14" y="-1" font-size="11.5" font-weight="600" fill="#18283e">
              {{ leaf.label }}
            </text>
            <text x="14" y="13" font-size="9.5" font-family="monospace" fill="#53637a">
              {{ formatShare(leaf.sharePercent) }} · {{ truncateLabel(leaf.subtitle, 22) }}
            </text>
          </g>
        </svg>
      </div>

      <!-- 模式 2：动态能力雷达图 -->
      <div v-else-if="activeMode === 'radar'" class="portrait-svg-wrap py-2" :key="`radar-${animEpoch}`">
        <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-center px-4 py-3">
          <div class="md:col-span-7 flex justify-center">
            <svg viewBox="-170 -165 340 330" class="w-full max-w-[360px] h-auto" role="img" aria-label="个人技术能力雷达图">
              <defs>
                <linearGradient id="hgRadarFill" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#315ee7" stop-opacity="0.34" />
                  <stop offset="100%" stop-color="#187e71" stop-opacity="0.24" />
                </linearGradient>
              </defs>

              <!-- 同心多边形网格 -->
              <polygon
                v-for="ring in [25, 50, 75, 100]"
                :key="ring"
                :points="radarPolygonPoints(ring)"
                fill="none"
                stroke="#cfd9e8"
                stroke-width="1"
                stroke-dasharray="3 3"
              />

              <!-- 轴线 -->
              <line
                v-for="axis in radarGeometry"
                :key="`axis-${axis.id}`"
                x1="0"
                y1="0"
                :x2="axis.outerX"
                :y2="axis.outerY"
                stroke="#dbe4f3"
                stroke-width="1"
              />

              <!-- 柔和旋转扫描扇区 -->
              <path
                v-if="!reducedMotion"
                d="M 0 0 L 0 -116 A 116 116 0 0 1 82 -82 Z"
                fill="#315ee7"
                fill-opacity="0.08"
                class="radar-sweep"
              />

              <!-- 动态数据多边形 -->
              <polygon
                :points="radarDataPoints"
                fill="url(#hgRadarFill)"
                stroke="#315ee7"
                stroke-width="2.2"
                stroke-linejoin="round"
                class="radar-shape"
              />

              <!-- 顶点节点与标签 -->
              <g
                v-for="axis in radarGeometry"
                :key="axis.id"
                class="cursor-pointer"
                @click="selectNode(axis)"
              >
                <circle
                  :cx="axis.valX"
                  :cy="axis.valY"
                  :r="selectedNode?.id === axis.id ? 6.5 : 4.8"
                  :fill="axis.color"
                  stroke="#ffffff"
                  stroke-width="1.8"
                />
                <text
                  :x="axis.labelX"
                  :y="axis.labelY"
                  :text-anchor="axis.anchor"
                  dominant-baseline="middle"
                  font-size="11"
                  font-weight="600"
                  fill="#18283e"
                >
                  {{ axis.label }}
                </text>
              </g>
            </svg>
          </div>

          <div class="md:col-span-5 space-y-2">
            <div class="text-xs font-bold text-[var(--color-text)] mb-1">雷达维度权重指数</div>
            <button
              v-for="axis in model.radarAxes"
              :key="`bar-${axis.id}`"
              type="button"
              @click="selectNode(axis)"
              class="w-full text-left p-2 rounded-xl border transition cursor-pointer"
              :class="selectedNode?.id === axis.id
                ? 'bg-[var(--color-surface)] border-[var(--color-primary)]'
                : 'bg-[var(--color-surface)]/80 border-[var(--color-border)] hover:border-[var(--color-text-subtle)]'"
            >
              <div class="flex items-center justify-between text-xs mb-1">
                <span class="font-semibold text-[var(--color-text)]">{{ axis.label }}</span>
                <span class="font-mono text-[11px]" :style="{ color: axis.color }">{{ axis.score }} / 100</span>
              </div>
              <div class="h-1.5 w-full rounded-full bg-[var(--color-surface-raised)] overflow-hidden">
                <div
                  class="h-full rounded-full radar-bar-fill"
                  :style="{ width: `${axis.score}%`, backgroundColor: axis.color }"
                ></div>
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- 模式 3：动态引力星图 -->
      <div v-else class="portrait-svg-wrap py-2" :key="`star-${animEpoch}`">
        <svg
          viewBox="-260 -165 520 330"
          class="w-full h-auto block max-h-[340px]"
          role="img"
          aria-label="个人技术引力星图"
          @mousemove="handleStarParallax"
          @mouseleave="parallax = { x: 0, y: 0 }"
        >
          <!-- 轨道环 -->
          <circle
            v-for="r in [56, 94, 132]"
            :key="`orbit-${r}`"
            cx="0"
            cy="0"
            :r="r"
            fill="none"
            stroke="#cfd9e8"
            stroke-width="1"
            stroke-dasharray="4 5"
          />

          <!-- 引力连线 -->
          <line
            v-for="node in animatedOrbitNodes"
            :key="`link-${node.id}`"
            x1="0"
            y1="0"
            :x2="node.x"
            :y2="node.y"
            :stroke="node.color"
            :stroke-opacity="selectedNode?.id === node.id || hoveredBranchId === node.branchId ? 0.78 : 0.2"
            :stroke-width="selectedNode?.id === node.id ? 2 : 1.1"
          />

          <!-- 中心用户恒星 -->
          <g class="cursor-pointer" @click="selectNode({ type: 'root', label: model.root.label, subtitle: model.root.primaryFocus, sharePercent: 100, color: '#315ee7', evidenceRepos: [] })">
            <circle r="34" fill="#315ee7" fill-opacity="0.12" class="root-halo" />
            <circle r="22" fill="#315ee7" />
            <text text-anchor="middle" dy="4" font-size="10.5" font-weight="700" fill="#ffffff">
              {{ truncateLabel(model.root.label, 6) }}
            </text>
          </g>

          <!-- 行星技术节点 -->
          <g
            v-for="node in animatedOrbitNodes"
            :key="node.id"
            class="cursor-pointer"
            :transform="`translate(${node.x}, ${node.y})`"
            @mouseenter="orbitPaused = true; hoveredBranchId = node.branchId"
            @mouseleave="orbitPaused = false; hoveredBranchId = null"
            @click="selectNode(node)"
          >
            <circle
              v-if="selectedNode?.id === node.id"
              :r="node.size + 7"
              fill="none"
              :stroke="node.color"
              stroke-opacity="0.45"
              stroke-width="1.5"
            />
            <circle
              :r="node.size"
              :fill="node.color"
              fill-opacity="0.16"
              :stroke="node.color"
              stroke-width="1.8"
            />
            <circle :r="Math.max(3, node.size * 0.42)" :fill="node.color" />
            <text
              :y="node.size + 12"
              text-anchor="middle"
              font-size="10"
              font-weight="600"
              fill="#18283e"
            >
              {{ truncateLabel(node.label, 14) }}
            </text>
          </g>
        </svg>
      </div>

      <!-- 底部节点详情洞察条 -->
      <div class="px-4 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div v-if="activeDetailNode" class="min-w-0 flex-1 space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: activeDetailNode.color || '#315ee7' }"></span>
            <span class="font-bold text-[var(--color-text)]">{{ activeDetailNode.fullName || activeDetailNode.label }}</span>
            <span v-if="activeDetailNode.sharePercent !== undefined" class="font-mono text-[11px] text-[var(--color-primary)]">
              {{ formatShare(activeDetailNode.sharePercent) }}
            </span>
            <span class="text-[11px] text-[var(--color-text-muted)]">{{ activeDetailNode.subtitle || activeDetailNode.detail }}</span>
          </div>
          <div v-if="(activeDetailNode.evidenceRepos || []).length > 0" class="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span class="text-[var(--color-text-subtle)]">关联项目：</span>
            <button
              v-for="repoName in activeDetailNode.evidenceRepos.slice(0, 4)"
              :key="repoName"
              type="button"
              @click="openEvidenceRepo(repoName, activeDetailNode.htmlUrl)"
              class="px-2 py-0.5 rounded-md bg-[var(--color-surface-raised)] border border-[var(--color-border)] hover:border-[var(--color-primary)] text-[var(--color-text)] hover:text-[var(--color-primary)] transition cursor-pointer font-mono text-[10px]"
            >
              {{ repoName }}
            </button>
          </div>
        </div>
        <div v-else class="text-[11px] text-[var(--color-text-muted)]">
          提示：点击或悬停树节点可查看分支占比与关联项目；点击分类标签可折叠或展开子树。
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useUserStore } from '../stores/user'
import { useHistoryStore } from '../stores/history'
import { buildPersonalPortraitModel } from '../models/portrait-tree'

const emit = defineEmits(['open-repo'])

const userStore = useUserStore()
const historyStore = useHistoryStore()

const viewModes = [
  { id: 'tree', label: '动态树状图' },
  { id: 'radar', label: '能力雷达' },
  { id: 'constellation', label: '引力星图' }
]

const activeMode = ref('tree')
const animEpoch = ref(1)
const pulseKey = ref(0)
const hoveredBranchId = ref(null)
const selectedNode = ref(null)
const collapsedBranches = ref(new Set())
const updateBanner = ref('')
const orbitTick = ref(0)
const orbitPaused = ref(false)
const parallax = ref({ x: 0, y: 0 })
const reducedMotion = ref(false)

let rafId = null

const model = computed(() => buildPersonalPortraitModel({
  cloudPortrait: userStore.cloudPortrait,
  localProfile: userStore.localProfile,
  profile: userStore.profile,
  repos: userStore.interestRepos.length ? userStore.interestRepos : userStore.repos,
  stars: userStore.interestStars.length ? userStore.interestStars : userStore.stars,
  history: historyStore.items,
  manualTags: userStore.manualTags
}))

const activeDetailNode = computed(() => {
  if (selectedNode.value) return selectedNode.value
  const firstDir = model.value.branches[0]?.children?.[0]
  return firstDir ? { ...firstDir, color: model.value.branches[0].color } : null
})

// 计算响应式水平树状图坐标与贝塞尔曲线
const treeLayout = computed(() => {
  const branches = model.value.branches
  const width = 760
  const rootX = 76
  const branchX = 270
  const leafX = 485

  const rows = []
  for (const b of branches) {
    const isCollapsed = collapsedBranches.value.has(b.id)
    const visibleChildren = isCollapsed ? [] : b.children
    rows.push({ branch: b, visibleChildren })
  }

  let totalSlots = 0
  for (const r of rows) {
    totalSlots += Math.max(1, r.visibleChildren.length) + 0.55
  }
  const height = Math.max(320, Math.round(totalSlots * 40 + 48))
  const rootY = Math.round(height / 2)

  const branchNodes = []
  const leafNodes = []
  const edges = []

  let cursorY = 34
  rows.forEach((row, bIdx) => {
    const b = row.branch
    const children = row.visibleChildren
    const blockHeight = Math.max(1, children.length) * 40
    const bY = Math.round(cursorY + blockHeight / 2 - 4)

    branchNodes.push({
      id: `branch-${b.id}`,
      branchId: b.id,
      type: 'branch',
      label: b.label,
      color: b.color,
      sharePercent: b.sharePercent,
      subtitle: `包含 ${b.children.length} 项信号`,
      evidenceRepos: b.children.flatMap(c => c.evidenceRepos || []).slice(0, 4),
      childCount: b.children.length,
      x: branchX,
      y: bY,
      delay: 110 + bIdx * 90
    })

    const dx1 = (branchX - rootX) * 0.5
    const d1 = `M ${rootX + 29} ${rootY} C ${rootX + 29 + dx1} ${rootY}, ${branchX - 66 - dx1} ${bY}, ${branchX - 66} ${bY}`
    edges.push({
      id: `e-root-${b.id}`,
      branchId: b.id,
      level: 1,
      d: d1,
      color: b.color,
      length: Math.round(Math.hypot(branchX - rootX, bY - rootY) + 80),
      delay: bIdx * 80,
      flowDur: 2.6 + (bIdx % 3) * 0.45
    })

    children.forEach((child, cIdx) => {
      const lY = Math.round(cursorY + cIdx * 40 + 18)
      const radius = Math.max(6.5, Math.min(11.5, 6.5 + Math.sqrt(Math.max(1, child.sharePercent)) * 0.65))
      const leafDelay = 220 + bIdx * 90 + cIdx * 45

      leafNodes.push({
        ...child,
        branchId: b.id,
        color: b.color,
        radius,
        isTop: cIdx === 0,
        x: leafX,
        y: lY,
        delay: leafDelay
      })

      const dx2 = (leafX - (branchX + 66)) * 0.5
      const d2 = `M ${branchX + 66} ${bY} C ${branchX + 66 + dx2} ${bY}, ${leafX - radius - dx2} ${lY}, ${leafX - radius} ${lY}`
      edges.push({
        id: `e-${b.id}-${cIdx}`,
        branchId: b.id,
        level: 2,
        d: d2,
        color: b.color,
        length: Math.round(Math.hypot(leafX - branchX, lY - bY) + 60),
        delay: 140 + bIdx * 80 + cIdx * 40,
        flowDur: 2.2 + ((bIdx + cIdx) % 4) * 0.35
      })
    })

    cursorY += blockHeight + 22
  })

  return {
    width,
    height,
    root: { x: rootX, y: rootY },
    branchNodes,
    leafNodes,
    edges
  }
})

// 雷达图几何计算
const radarGeometry = computed(() => {
  const axes = model.value.radarAxes
  const count = Math.max(3, axes.length)
  const maxR = 114
  return axes.map((axis, i) => {
    const angle = (-Math.PI / 2) + (2 * Math.PI * i) / count
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const rVal = (axis.score / 100) * maxR
    const rLabel = maxR + 22
    return {
      ...axis,
      sharePercent: axis.score,
      subtitle: axis.detail,
      outerX: Math.round(cos * maxR),
      outerY: Math.round(sin * maxR),
      valX: Math.round(cos * rVal),
      valY: Math.round(sin * rVal),
      labelX: Math.round(cos * rLabel),
      labelY: Math.round(sin * rLabel),
      anchor: cos > 0.2 ? 'start' : cos < -0.2 ? 'end' : 'middle'
    }
  })
})

function radarPolygonPoints(percent) {
  const count = Math.max(3, model.value.radarAxes.length)
  const r = (percent / 100) * 114
  const pts = []
  for (let i = 0; i < count; i++) {
    const angle = (-Math.PI / 2) + (2 * Math.PI * i) / count
    pts.push(`${Math.round(Math.cos(angle) * r)},${Math.round(Math.sin(angle) * r)}`)
  }
  return pts.join(' ')
}

const radarDataPoints = computed(() => {
  if (!radarGeometry.value.length) return '0,0'
  return radarGeometry.value.map(a => `${a.valX},${a.valY}`).join(' ')
})

// 星图轨道动画位置
const animatedOrbitNodes = computed(() => {
  const t = orbitTick.value
  return model.value.constellationNodes.map((node) => {
    const speed = node.tier === 1 ? 0.24 : node.tier === 2 ? -0.17 : 0.12
    const deg = node.baseAngle + (reducedMotion.value ? 0 : t * speed)
    const rad = (deg * Math.PI) / 180
    const r = node.tier === 1 ? 56 : node.tier === 2 ? 94 : 132
    return {
      ...node,
      x: Math.round(Math.cos(rad) * r * 1.35 + parallax.value.x * (node.tier * 3)),
      y: Math.round(Math.sin(rad) * r + parallax.value.y * (node.tier * 2))
    }
  })
})

function truncateLabel(text, maxLen) {
  const str = String(text || '')
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str
}

function formatShare(val) {
  const num = Number(val || 0)
  return num > 0 && num < 0.1 ? '<0.1%' : `${num.toFixed(1)}%`
}

function switchMode(modeId) {
  activeMode.value = modeId
  animEpoch.value++
}

function replayAnimation() {
  animEpoch.value++
}

function toggleBranch(branch) {
  const next = new Set(collapsedBranches.value)
  if (next.has(branch.branchId)) next.delete(branch.branchId)
  else next.add(branch.branchId)
  collapsedBranches.value = next
  selectedNode.value = branch
}

function selectNode(node) {
  selectedNode.value = node
}

function handleStarParallax(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  parallax.value = {
    x: ((e.clientX - rect.left) / rect.width - 0.5) * 2,
    y: ((e.clientY - rect.top) / rect.height - 0.5) * 2
  }
}

async function authorizeAndSync() {
  updateBanner.value = ''
  try {
    await userStore.startCloudBind()
  } catch (err) {
    updateBanner.value = ''
  }
}

async function refreshCloudNow() {
  updateBanner.value = ''
  await userStore.refreshCloudPortraitData({ compute: true })
  animEpoch.value++
  pulseKey.value++
  if (!userStore.cloudPortraitError && userStore.cloudPortrait?.portrait) {
    updateBanner.value = `云端画像已更新（模型 ${userStore.cloudPortrait.modelVersion || 'active'}）`
  }
}

function dismissBanner() {
  updateBanner.value = ''
  userStore.cloudAuthError = null
}

function openEvidenceRepo(repoName, explicitUrl = '') {
  if (!repoName || !repoName.includes('/')) return
  const htmlUrl = explicitUrl || `https://github.com/${repoName}`
  emit('open-repo', { fullName: repoName, canonicalKey: repoName.toLowerCase(), htmlUrl }, 'portrait_tree')
}

watch(() => userStore.cloudPortraitJustUpdatedAt, (ts) => {
  if (!ts) return
  animEpoch.value++
  pulseKey.value++
  updateBanner.value = `授权成功，云端个人画像已自动更新（${userStore.cloudPortrait?.modelVersion || 'active'}）`
})

onMounted(() => {
  reducedMotion.value = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  let last = performance.now()
  const tick = (now) => {
    if (activeMode.value === 'constellation' && !orbitPaused.value && !reducedMotion.value) {
      const dt = Math.min(60, now - last)
      orbitTick.value += dt * 0.035
    }
    last = now
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
})
</script>

<style scoped>
.portrait-canvas-shell {
  background: var(--color-surface);
}

.portrait-stage {
  background-color: #f7faff;
  background-image: radial-gradient(rgba(49, 94, 231, 0.14) 1px, transparent 1px);
  background-size: 18px 18px;
  overflow: hidden;
}

.portrait-update-wave {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 40px;
  height: 40px;
  border-radius: 999px;
  border: 2px solid #26744a;
  pointer-events: none;
  transform: translate(-50%, -50%) scale(0.2);
  animation: portrait-wave-expand 0.9s cubic-bezier(0.16, 0.84, 0.24, 1) forwards;
}

.tree-branch-path {
  stroke-dasharray: var(--path-len);
  stroke-dashoffset: var(--path-len);
  animation: branch-grow 0.65s cubic-bezier(0.22, 0.8, 0.26, 1) var(--grow-delay) forwards;
  transition: stroke-opacity 0.2s ease, stroke-width 0.2s ease;
}

.tree-branch-node,
.tree-leaf-node {
  opacity: 0;
  animation: node-fade-pop 0.42s ease var(--node-delay) forwards;
  transition: opacity 0.2s ease;
}

.is-dimmed {
  opacity: 0.26 !important;
}

.root-halo {
  transform-origin: center;
  animation: root-breathe 3.4s ease-in-out infinite;
}

.leaf-pulse {
  transform-origin: center;
  animation: leaf-glow 2.4s ease-in-out infinite;
}

.radar-shape {
  transform-origin: center;
  animation: radar-bloom 0.65s cubic-bezier(0.22, 0.8, 0.26, 1) both;
}

.radar-sweep {
  transform-origin: 0 0;
  animation: radar-spin 7s linear infinite;
}

.radar-bar-fill {
  animation: bar-grow 0.6s ease-out both;
}

@keyframes branch-grow {
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes node-fade-pop {
  from {
    opacity: 0;
    transform: translate(var(--tx, 0), var(--ty, 0)) scale(0.95);
  }
  to {
    opacity: 1;
  }
}

@keyframes root-breathe {
  0%, 100% {
    transform: scale(0.94);
    opacity: 0.72;
  }
  50% {
    transform: scale(1.1);
    opacity: 1;
  }
}

@keyframes leaf-glow {
  0%, 100% {
    opacity: 0.16;
  }
  50% {
    opacity: 0.36;
  }
}

@keyframes radar-bloom {
  from {
    opacity: 0;
    transform: scale(0.25);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes radar-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes bar-grow {
  from {
    width: 0;
  }
}

@keyframes portrait-wave-expand {
  from {
    opacity: 0.8;
    transform: translate(-50%, -50%) scale(0.3);
  }
  to {
    opacity: 0;
    transform: translate(-50%, -50%) scale(16);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tree-branch-path {
    stroke-dashoffset: 0;
    animation: none !important;
  }
  .tree-branch-node,
  .tree-leaf-node,
  .root-halo,
  .leaf-pulse,
  .radar-shape,
  .radar-sweep,
  .radar-bar-fill,
  .portrait-update-wave {
    opacity: 1;
    animation: none !important;
  }
}
</style>
